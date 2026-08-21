# Architecture

This is the deep dive into how Stylus Cache Sentinel is put together. It covers
the data flow, the storage schema, and the reason behind each design choice. If
you would rather just get something done, start with the
[Quickstart](./quickstart.md) or the [Command reference](./commands.md).

---

## The problem

Stylus contracts are WASM, compiled from Rust, C, or C++. To run cheaply, a
contract has to sit in the `ArbWasmCache`. Miss the cache, and every call pays
the full activation cost.

An on-chain `CacheManager` hands out the slots. It runs a **decaying-bid
auction**. Anyone can bid ETH to hold a codehash in the cache. Bids lose value
as the block timestamp climbs. When the cache fills up, the lowest bid is
dropped to make room for a bigger one.

So keeping a contract cached is an endless chore. You watch the chain for
eviction pressure. You work out the new floor, which keeps sliding. You bid
again before you lose the slot. Sentinel runs that loop for you.

---

## Layered design

The system is built in layers. Each milestone ships a layer that stands on its
own.

| Layer | Modules | Responsibility |
| ----- | ------- | -------------- |
| **Indexer** | `resolver`, `indexer/*` | Turn the on-chain `CacheManager` event stream into a queryable local SQLite replica. |
| **Storage / integrity** | `db/*`, `indexer/reconcile` | Normalized schema, idempotent writes, and reconciliation of derived state against live chain state. |
| **CLI** | `index.ts`, `cli/*`, `wallet`, `codehash` | Developer-facing commands, user config, and env-only wallet signing. |
| **Sentinel** | `sentinel/*` | The autonomous monitoring + bidding loop built on top of everything below. |

Every layer is a plain TypeScript module. Each one talks to a SQLite file or a
viem client, and nothing else. There is no ORM, no migration framework, and no
background service manager.

---

## Data flow — one `sync` run

```
                                                     Arbitrum RPC
                                                          |
                            +-----------------------------+----------------------+
                            |                                                    |
                            v                                                    v
                 +----------------------+                           +----------------------+
                 |      resolver        |                           |       state          |
                 | allCacheManagers() ->|                           | cacheSize / queueSize|
                 |   active manager     |                           |  decay / isPaused    |
                 +----------+-----------+                           +-----------+----------+
                            |                                                    |
                            v                                                    |
                 +----------------------+                                        |
                 |   backfill  +  tail  |   --- viem getLogs --- RPC             |
                 |  (paged,   resumes   |                                        |
                 |   from last_block)   |                                        |
                 +----------+-----------+                                        |
                            |                                                    |
                            v                                                    |
                 +----------------------+                                        |
                 |  format.parseEvents  |                                        |
                 |  raw Log -> typed    |                                        |
                 |   ParsedBid, etc.    |                                        |
                 +----------+-----------+                                        |
                            |                                                    |
                            v                                                    v
                 +-------------------------------------------------------------------+
                 |                         db/store                                  |
                 |   upsertProgram, upsertCodehash, persistParsedEvents (one tx):    |
                 |     - INSERT OR IGNORE on bids / evictions / config_events        |
                 |     - update sync_meta.last_block                                 |
                 |     - record skipped ranges in sync_gaps                          |
                 +---------------------------+---------------------------------------+
                                             |
                                             v
                                     +---------------+
                                     |  sentinel.db  |   SQLite + WAL
                                     +-------+-------+
                                             |
                 +---------------------------+-----------------------------+
                 |                                                         |
                 v                                                         v
       +-------------------+                                   +------------------------+
       |  CLI `status`     |                                   |  CLI `reconcile`       |
       |  live view of     |                                   |  derived set  vs       |
       |  queue / decay    |                                   |  getEntries(), report  |
       +-------------------+                                   |  drift / gaps / config |
                                                               +------------------------+
```

Step by step:

1. **`resolveChain()`** asks the RPC for its chain id and adopts it. A known
   Arbitrum-family id resolves to viem's definition; anything else is
   synthesized as an Orbit chain. Nothing about the chain is assumed, which is
   what lets a bid be signed correctly off Arbitrum One.
2. **`resolveCacheManager()`** calls `allCacheManagers()` on the `ArbWasmCache`
   precompile, which sits at `0x…0072` on every Arbitrum chain. That call
   returns the active `CacheManager`. No address is hard-coded either, so the
   same build works on Arbitrum One, Nova, and Orbit chains.
3. **`getDb()`** opens SQLite and runs `initSchema`, which leaves
   `schema_version` at 2. Note that this is not a migration. If it finds a
   pre-release v1 database, it **drops the tables and starts over**, so the old
   rows are lost. Re-run `sync` to rebuild them.
4. **`backfill()`** starts at `max(fromBlock, sync_meta.last_block + 1)` and
   walks to the chain head. It moves in paged `getLogs` batches of `batchSize`
   blocks, 2000 by default. For each batch it decodes the logs with
   `parseEvents()` and fetches the block timestamps. It then opens a **single
   transaction** to upsert the dim rows, `INSERT OR IGNORE` the facts, and push
   `sync_meta.last_block` forward. If a batch still fails after its retries, the
   range goes into `sync_gaps` and the scan moves on. One bad RPC range cannot
   halt the whole run.
5. Once backfill reaches the head, **`startTail()`** takes over. It repeats the
   same parse and persist cycle on every poll, every 4 seconds by default.
6. **`reconcile`** runs whenever you want. It does not need `sync` to be
   running.

---

## The indexer (M1)

- **Dynamic manager lookup** — `allCacheManagers()` returns the active
  `CacheManager`. The indexer never assumes an address.
- **Resumable backfill** — every committed batch checkpoints
  `sync_meta.last_block`. Restarts are cheap, so you can stop a long scan
  whenever you like.
- **Gap tolerance** — a block range that keeps failing goes into `sync_gaps`,
  where `reconcile` will report it. The run does not crash.
- **Live tail** — once backfill ends, new events are polled on an interval.

## Data transformation & integrity (M2)

- **Normalized v2 schema** — programs and codehashes live in their own dimension
  tables, keyed by integer. The wide fact tables carry just the key, never
  repeated hex.
- **BLOB storage** — a `codehash` is 32 bytes, a program `address` is 20, and a
  `tx_hash` is 32. All three are stored as raw bytes, not hex strings. That
  strips roughly 60% of the bytes per row against the old v1 layout.
- **Idempotent writes** — every fact row carries `UNIQUE(tx_hash, log_index)`,
  and inserts use `INSERT OR IGNORE`. Re-running `sync` over a range you already
  indexed does nothing at all.
- **Reconciliation** — `reconcile` checks the local copy against the chain. It
  compares the derived "currently cached" set and the total queue size against
  live `getEntries()` and `queueSize()`. It also checks live `decay`,
  `cacheSize`, and `isPaused` against the last config event on file. On drift it
  exits non-zero, so you can wire it into CI or cron as an integrity gate.

---

## Schema (v2)

```
programs      (id PK, address BLOB UNIQUE, first_seen_block, first_seen_ts)
codehashes    (id PK, codehash BLOB UNIQUE, program_id FK, size, first_seen_block, first_seen_ts)

bids          (id PK, codehash_id FK, program_id FK, bid_wei TEXT, size,
               block_number, tx_hash BLOB, log_index, timestamp,
               UNIQUE(tx_hash, log_index))

evictions     (id PK, codehash_id FK, bid_wei TEXT, size, block_number,
               tx_hash BLOB, log_index, timestamp,
               UNIQUE(tx_hash, log_index))

config_events (id PK, event_type TEXT, value TEXT NULL, block_number,
               tx_hash BLOB, log_index, timestamp,
               UNIQUE(tx_hash, log_index))

bid_actions   (id PK, codehash BLOB, program BLOB NULL, bid_wei TEXT, status,
               tx_hash BLOB NULL, reason, created_at, confirmed_at NULL)

sync_gaps     (from_block, to_block, reason, recorded_at)
sync_meta     (key, value)   -- includes schema_version, last_block
```

- **"Currently cached" is derived, not stored.** For each codehash, take its
  latest bid. If no eviction follows it at a strictly later `(block_number,
  log_index)`, the codehash is still cached. This mirrors how the on-chain
  `CacheManager` tracks occupancy, and it is what `reconcile` holds up against
  `getEntries()`.
- **`bid_actions`** is the M4 audit trail. Every decision, dry run, block, and
  submission is appended here. It also backs the per-window spend cap through
  `getSpendWeiSince`, and it feeds the `history` command.
- **`config_events`** stores `SetCacheSize`, `SetDecayRate`, `Pause`, and
  `Unpause`. These are the values that shape the decay curve the bidder reasons
  about.

---

## The CLI (M3)

The CLI takes subcommands, in the form `sentinel <command>`. Its flag parser in
`cli/args.ts` has no dependencies and makes no shell assumptions. It ships as a
`sentinel` bin, so it behaves the same on Linux, macOS, and Windows under Node
20 or newer.

User settings live at `~/.sentinel/config.json`, handled by `cli/userConfig.ts`
and checked on **both** write and load. The signing key comes from the
`SENTINEL_PRIVATE_KEY` environment variable alone, by way of `wallet.ts`. It is
never written to disk.

The [Configuration manual](./configuration.md) and the
[Command reference](./commands.md) cover the full surface.

---

## The sentinel loop (M4)

`sentinel run` is the monitor that runs on its own. Its bidding logic earns a
document of its own: **[Bidding logic](./bidding.md)** covers decay-space
accounting, the decision policy, and the ordered fail-safe stack. The loop in
`sentinel/run.ts` handles the orchestration around it.

- Resolve the watchlist to concrete targets. Re-resolve every so often, so a
  redeploy is picked up without a restart.
- Take one on-chain snapshot per tick with `buildTickContext`, then assess every
  target against it. Assessments run in bounded chunks, batched through
  Multicall3 where the chain offers it.
- Act one target at a time. Serial order is what keeps the per-window spend cap
  honest. A per-target cooldown stops the loop re-bidding on every tick.
- Stop bidding for the tick if `haltOnDrift` is on and `reconcile` finds drift.

---

## Tech stack & rationale

- **TypeScript**, strict, ES2022, CommonJS. It runs under `ts-node` while you
  develop, and compiles to `dist/` for production.
- **[viem](https://viem.sh/)** — the chain client. It also handles ABI encoding,
  log decoding, and typed contract reads.
- **[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)** — SQLite,
  synchronous. We picked it over async drivers and over any ORM because the
  indexer is a single process writing batches in a tight loop. Synchronous
  prepared statements inside one transaction are the simplest way to get both
  throughput and strict idempotency.
- **dotenv** loads `.env`. **chalk** colors the output. **node:test** runs the
  tests, and ships with Node 20.

There is no ORM, no migration framework, and no service worker. `initSchema`
handles schema changes inline. It keys off a `schema_version` value, and drops
and recreates the tables when it meets the pre-release v1 layout.

---

## Repository layout

```
src/
  abi.ts                  ABI slices (ArbWasmCache + CacheManager + write ABI + errors)
  config.ts               env loading + static constants
  provider.ts             chain discovery + viem PublicClient + multicall toggle
  resolver.ts             active CacheManager lookup
  wallet.ts               SENTINEL_PRIVATE_KEY signer + wallet client
  codehash.ts             target classification + program→codehash resolution
  types.ts                shared types
  indexer/
    backfill.ts           historical paged scan, resumable
    tail.ts               live poll loop
    format.ts             parseEvents + pretty-printer
    state.ts              live on-chain state reader
    reconcile.ts          DB-vs-chain drift report
  cli/
    args.ts               zero-dep flag parser
    userConfig.ts         ~/.sentinel/config.json load/save/validate
  sentinel/
    assess.ts             pure bid-decision math + per-target assessment
    bidder.ts             placeBid submission + fail-safes + audit
    run.ts                the autonomous monitoring/bidding loop
  db/
    schema.ts             v2 schema + v1 auto-drop + bid_actions audit table
    store.ts              connection + upserts + persist + queries + bid audit
  index.ts                CLI entry / command router

test/
  smoke.test.ts           parseEvents + getCurrentlyCached coverage
  cli.test.ts             config validation + target classification
  sentinel.test.ts        bid-decision math
  e2e/
    mainnet.test.ts       M6 end-to-end validation against Arbitrum One

scripts/
  doc-coverage.js         inline documentation coverage check (M5 KPI)
  readability.js          Flesch Reading Ease check for docs (M5 KPI)

tsconfig.json             prod build (rootDir = src/)
tsconfig.test.json        test type-check (includes test/)
```
