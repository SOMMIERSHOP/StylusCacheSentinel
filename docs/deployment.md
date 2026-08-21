# Deployment

Sentinel ships as a container image. This is the supported way to run it as a
service, rather than as a command you type by hand.

The image is built from the [`Dockerfile`](../Dockerfile) at the repository
root. It runs as a non-root user, writes only to `/data`, and starts in dry-run
mode. Nothing it does by default can spend ETH.

---

## Pull a published image

Tagged releases are published to the GitHub Container Registry:

```bash
docker pull ghcr.io/SOMMIERSHOP/stylus-cache-sentinel:latest
```

Images are multi-arch (`linux/amd64` and `linux/arm64`). Pin a version tag
rather than `latest` for anything you depend on.

---

## Build it yourself

```bash
docker build -t stylus-cache-sentinel:latest .
```

The build has three stages. One compiles TypeScript, one resolves production
dependencies, and the last carries only the result. Neither the compiler nor
the C/C++ toolchain ends up in the image you run.

The base image is pinned by digest, not just by tag, so rebuilding this
Dockerfile later produces the same base rather than whatever `node:22-alpine`
happens to point at that day. Update it deliberately with
`docker manifest inspect node:22-alpine`, and use the top-level index digest —
a platform-specific one will not pull on the other architecture.

---

## Run a one-off command

The entrypoint is the CLI, so any command works as a container argument.

```bash
docker run --rm stylus-cache-sentinel:latest status
docker run --rm stylus-cache-sentinel:latest help
```

With no argument it prints usage. It never starts bidding on its own.

---

## Persist the index and config

Everything Sentinel writes lives under `/data`. Mount a volume there, or you
will re-backfill from Stylus genesis on every restart.

```bash
docker volume create sentinel-data

docker run --rm -v sentinel-data:/data stylus-cache-sentinel:latest config init
docker run --rm -v sentinel-data:/data stylus-cache-sentinel:latest \
  watch add 0xYourProgram --max-bid 0.01
docker run --rm -v sentinel-data:/data stylus-cache-sentinel:latest watch list
```

| Path | Holds | Set by |
| ---- | ----- | ------ |
| `/data/sentinel.db` | The SQLite index. | `DB_PATH` |
| `/data/config` | The user config and watchlist. | `SENTINEL_HOME` |

Both variables are already set in the image. Override them only if you want a
different layout.

---

## Run the loop as a service

```bash
docker compose up -d      # dry-run
docker compose logs -f
```

See [`docker-compose.yml`](../docker-compose.yml). It mounts a named volume,
restarts unless stopped, and runs `sentinel run` in dry-run.

It also sets three things that matter on a long-lived host:

| Setting | Value | Why |
| ------- | ----- | --- |
| `logging.options.max-size` / `max-file` | 10 MB × 5 | The loop logs a line per target every 5 seconds. On the default json-file driver with no cap, that fills the disk. |
| `mem_limit` / `cpus` | 512 MB, 1 CPU | A runaway backfill hits a wall inside the container instead of taking the host with it. Raise it if you watch many targets. |
| `healthcheck` | see below | Makes a wedged loop observable to whatever is watching. |

---

## Health

`restart: unless-stopped` only reacts to a process that **exits**. The failure
that actually matters for a bidding loop is the opposite one: still running,
no longer ticking — wedged against an unresponsive RPC. To an orchestrator
that container looks fine indefinitely.

Sentinel handles this from both directions.

**Recovery** comes from a watchdog inside the process. It runs on its own
timer, independent of the tick, and calls `exit(1)` once the loop stops making
progress. That exit is what gives `restart: unless-stopped` something to react
to, with no orchestrator required.

**Observability** comes from the heartbeat the loop stamps every tick, which
the image's `HEALTHCHECK` reads:

```bash
docker inspect --format '{{.State.Health.Status}}' <container>
docker compose ps          # shows (healthy) / (unhealthy)
docker compose exec sentinel node dist/index.js health
```

A loop is called wedged after it misses several consecutive ticks. The
threshold scales with your `pollIntervalMs`, and never falls below `1.5 ×` the
bid confirmation timeout — otherwise the watchdog could fire during a slow
receipt and kill the process with a real transaction in flight. Progress is
stamped per bid and per batch of reads, not only at the end of a tick, so a
tick containing several live bids cannot accumulate past the limit either.

Restarts are therefore a designed event, and the per-target cooldown is read
from the persisted audit trail rather than held in memory — so a restart mid
-cooldown does not forget a bid that is still propagating.

The check reads one local file — no RPC, no database. That is deliberate: a
health probe that depended on the chain would report unhealthy during exactly
the network trouble the loop is built to ride out. For the same reason, a tick
that *throws* still counts as alive; per-tick errors are caught and logged by
design.

Plain `docker compose` **reports** health but never restarts on it — Docker's
restart policy ignores health status. That is what the in-process watchdog is
for. Swarm, Kubernetes, and `autoheal`-style sidecars *do* act on health status,
and they compose fine with the watchdog; whichever notices first wins.

### Which commands report health

`run` and `sync` both stamp the heartbeat, so both are covered. The
`HEALTHCHECK` applies to **every** container built from this image, though, so
a long-lived container running anything else will report unhealthy forever.
Disable the check on such a service:

```yaml
services:
  something-else:
    image: stylus-cache-sentinel:latest
    command: ["reconcile"]
    healthcheck:
      disable: true
```

One-off containers (`status`, `inspect`, `config …`) exit before the start
period elapses, so they need no such handling.

---

## Going live

Two things have to change together, and both are deliberate.

1. Supply a funded signer through the environment. **Never** bake a key into
   an image or commit one to a compose file.
2. Change the command to `run --live`.

```bash
docker run -d --name sentinel \
  -v sentinel-data:/data \
  -e ARB_RPC_URL="https://your-private-rpc" \
  -e SENTINEL_PRIVATE_KEY="0x..." \
  stylus-cache-sentinel:latest run --live
```

With compose, set `SENTINEL_PRIVATE_KEY` in your shell or a local `.env` file
that git ignores, then uncomment the `--live` command.

Read the [bidding fail-safes](./bidding.md#3-the-fail-safe-stack) before you do
this. Start with a low `maxBidEth` and a low `maxSpendPerWindowEth`, watch a few
dry-run cycles and `sentinel history`, and only then raise the caps.

---

## Operational notes

**Use a private RPC.** The public endpoint rate-limits a full backfill from
Stylus genesis. Set `ARB_RPC_URL`.

**Which chain you get follows the RPC.** The image is not pinned to Arbitrum
One. Point it at Nova or an Orbit chain and it adopts that chain, including for
signing. Run `status` and read the `Chain:` line to confirm.

**Shutdown is clean.** `run` and `sync` both handle `SIGTERM`, so
`docker stop` ends the current tick and exits 0 without waiting out the grace
period. `init: true` in the compose file covers the commands that install no
handler of their own.

**Back up the volume, not the image.** The image is reproducible from the
Dockerfile. The index in `/data` is not — rebuilding it means re-scanning the
chain from genesis.
