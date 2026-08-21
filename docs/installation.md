# Installation

## Requirements

- **Node.js 20 or newer.** The tests use the built-in `node:test` runner, so
  older versions will not work.
- **An Arbitrum RPC endpoint.** The public one at `https://arb1.arbitrum.io/rpc`
  is fine for a quick look. A full backfill will hit its rate limits. For real
  runs, use Alchemy, Infura, your own node, or an Orbit chain RPC.
- **A funded EOA private key.** You only need this to place real bids, with
  `run --live` or `bid --yes`. Read-only commands need no wallet.

One note on native code. `better-sqlite3` builds a native addon when you run
`npm install`. On most machines this just works. If it fails, you need a C/C++
toolchain: Xcode Command Line Tools on macOS, `build-essential` and `python3` on
Debian or Ubuntu, and the Visual Studio Build Tools on Windows.

---

> Running Sentinel as a service rather than by hand? Skip this page and use the
> container image instead — see [Deployment](./deployment.md).

## Install from source

```bash
git clone https://github.com/SOMMIERSHOP/stylus-cache-sentinel.git
cd stylus-cache-sentinel
npm install
```

## Build

```bash
npm run build      # compiles src/ -> dist/ via tsc
```

This writes `dist/index.js`, which the `sentinel` bin points at. While
developing, you can skip the build. Run straight from TypeScript with `ts-node`
instead, as shown below.

---

## Configure the environment

Copy the example env file and edit it:

```bash
cp .env.example .env
```

```dotenv
ARB_RPC_URL=https://arb1.arbitrum.io/rpc
DB_PATH=./sentinel.db
# SENTINEL_PRIVATE_KEY=0x...   # only for `run --live` / `bid --yes`
```

- `ARB_RPC_URL` — the Arbitrum RPC used by the indexer and by all reads.
- `DB_PATH` — where the local SQLite copy lives.
- `SENTINEL_PRIVATE_KEY` — the signer for live bids. **Keep it secret.** It is
  read from the environment only, and never written to disk.

The automation layer keeps a **separate** user config at
`~/.sentinel/config.json`. Set `SENTINEL_HOME` to move that directory. The
[Configuration manual](./configuration.md) lists every option.

---

## Verify

```bash
npm test           # smoke + CLI + sentinel unit tests — no RPC required
npm run status     # one live RPC round-trip: prints current cache state
npm run test:e2e   # full end-to-end run against Arbitrum One (read-only)
```

Check two things. Is `npm test` green? Does `npm run status` print a
`CacheManager` address and the current cache usage? If both hold, you are ready.
Move on to the [Quickstart](./quickstart.md).

---

## Running the CLI

There are three ways to run a command. They all do the same thing.

| Mode | Example | When |
| ---- | ------- | ---- |
| Built bin | `sentinel status` | After `npm run build` (and `npm link` / global install). |
| npm script | `npm run status` | Convenience wrappers for the common commands. |
| ts-node (dev) | `ts-node src/index.ts status` | Running from source without building. |

In these docs, `sentinel <command>` is short for any of the three.
