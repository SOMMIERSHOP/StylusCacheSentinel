# Stylus Cache Sentinel — deployable image.
#
# Three stages so the runtime layer carries neither the TypeScript toolchain
# nor the C/C++ compiler:
#
#   build  — full dev dependencies, compiles src/ -> dist/
#   deps   — production dependencies only, with better-sqlite3's native addon
#            compiled against this exact Node version
#   runtime— dist/ + production node_modules, running as a non-root user
#
# Pinned to Node 22 on Alpine. The `deps` and `runtime` stages must stay on the
# same base image: better-sqlite3 compiles a native addon against a specific
# Node ABI and libc, so copying node_modules from a glibc base into a musl one
# (or vice versa) yields a module that builds fine and then fails to load at
# runtime.

# Pinned by digest, not just by tag, so a rebuild six months from now produces
# the same image rather than silently picking up whatever `22-alpine` points at
# that day. This is the multi-arch *index* digest, so it resolves on both amd64
# (CI) and arm64 (Apple silicon) — a platform-specific manifest digest would
# fail to pull on the other architecture.
# To update deliberately: docker manifest inspect node:22-alpine
ARG NODE_VERSION=22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

# --- build -----------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /app

# Alpine is musl, so better-sqlite3 has no prebuilt binary and compiles here.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- deps ------------------------------------------------------------------
# Resolved separately from `build` so the runtime tree never contains the
# TypeScript toolchain, and so this layer is cached independently of src/ edits.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Prune what only mattered at build time. `--omit=dev` does not remove these:
#   typescript  — an *optional peer* of viem/abitype/ox, pulled in for type
#                 inference only and never required at runtime (~23 MB)
#   deps/, src/ — better-sqlite3's bundled SQLite sources, already compiled
#                 into build/Release/better_sqlite3.node (~10 MB)
#   obj.target  — intermediate object files from that compile
RUN rm -rf \
      node_modules/typescript \
      node_modules/better-sqlite3/deps \
      node_modules/better-sqlite3/src \
      node_modules/better-sqlite3/build/Release/obj.target \
      node_modules/better-sqlite3/build/deps

# Type declarations and sourcemaps are never loaded by the Node runtime; viem
# alone ships ~1400 .d.ts files. Worth ~37 MB.
RUN find node_modules \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \) -type f -delete

# Fail the build here rather than at runtime if pruning went too far.
RUN node -e "require('better-sqlite3'); require('viem'); require('dotenv'); require('chalk'); console.log('runtime deps load OK')"

# --- runtime ---------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production

# /data holds the SQLite index and the user config, and is the only path the
# container writes to. Declared as a volume so neither survives only in the
# container's writable layer — without this, `sync` output is lost on recreate.
ENV DB_PATH=/data/sentinel.db \
    SENTINEL_HOME=/data/config

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Run unprivileged. The `node` user ships with the base image; /data must be
# owned by it or every write fails at runtime.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

# Reports whether the loop is still ticking, by reading the heartbeat it stamps.
#
# To be precise about what this does and does not do: Docker's restart policy
# fires on container *exit* and ignores health status entirely, so this check
# does not by itself recover anything. It makes a wedge observable — `docker ps`
# shows unhealthy, `docker events` emits health_status — which is the hook an
# external monitor or orchestrator acts on. Recovery comes from the in-process
# watchdog in src/sentinel/run.ts, which exits on the same condition so the
# restart policy has something to react to.
#
# start-period covers first startup, when no tick has completed yet. The check
# reads a local file only — no RPC — so a chain outage does not mark a loop
# unhealthy for correctly riding out the outage.
#
# Applies to every container from this image. `run` and `sync` both stamp the
# heartbeat; a long-lived container running anything else will report unhealthy,
# so disable the check for such a service (see docker-compose.yml).
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "dist/index.js", "health"]

# Exec form, so the CLI is PID 1 and receives SIGTERM directly — `sync` and
# `run` both install handlers and shut down cleanly on it. Run with `--init`
# if you want a reaper for the no-handler commands.
ENTRYPOINT ["node", "dist/index.js"]

# Safe default: prints usage rather than starting to spend. Override with the
# command you want, e.g. `docker run ... sentinel run --live`.
CMD ["help"]
