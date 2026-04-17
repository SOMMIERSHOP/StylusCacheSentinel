# Stylus Cache Sentinel

Indexer and (eventually) automation agent for the Arbitrum Stylus
[`CacheManager`](https://docs.arbitrum.io/stylus/concepts/stylus-cache-manager)
bid/eviction system. Captures the on-chain cache bidding flow into a local
SQLite replica, reconciles derived state against live chain state, and will
grow into a CLI that automatically keeps Stylus contracts cached via
intelligent bid resubmission.

This repo is being delivered against an Arbitrum grant
(6 milestones, 6 months). See the [Roadmap](#roadmap) for the per-milestone
cut line; the sections marked **"Now"** describe what is merged on `main`.

---

## Overview

Arbitrum Stylus lets developers ship WASM contracts in Rust / C / C++.
To execute fast, a compiled program must live in the `ArbWasmCache`. Cache
slots are awarded by an on-chain `CacheManager` that runs a decaying-bid
auction: anyone can bid ETH to keep a codehash cached, and the lowest-bid
entry is evicted when a larger bid arrives and the cache is full. If a
program falls out of cache, the next call pays the full JIT/activation cost.

Keeping a contract perpetually cached currently requires:

- Watching the chain for evictions that affect your codehash.
- Computing the current minimum bid (bids decay with block timestamp).
- Submitting a new bid before your slot expires.
- Repeating this forever, 24/7, for every contract you care about.

Stylus Cache Sentinel automates all of that. The project is layered so each
milestone ships something independently useful:

1. **Indexer** — turns the on-chain event stream into a queryable local DB.
2. **Transformation / integrity** — normalized schema, idempotent writes,
   reconciliation against live chain state.
3. **CLI** — developer-facing commands and wallet integration.
4. **Sentinel** — the autonomous monitoring/bidding agent built on top of
   the indexer and CLI.
5. **Documentation**.
6. **Mainnet deployment & launch**.

---

As of the latest commit on `main`, the project ships **Milestones 1 and 2**.

### Indexer (M1)

- Resolves the active `CacheManager` via
  `ArbWasmCache.allCacheManagers()` — no hard-coded addresses, works on
  Arbitrum One / Nova / Orbit.
- Backfills historical `CacheManager` events from the Stylus genesis block
  to head, in paged `getLogs` batches, with retry + skip-on-RPC-failure.
- Tails new events after backfill completes, polling on a configurable
  interval.
- Reads live chain state (`cacheSize`, `queueSize`, `decay`, `isPaused`)
  for status output.

### Data transformation & integrity (M2)

- **Normalized v2 schema** — programs and codehashes are split into dim
  tables with integer FKs, reducing duplication in the wide fact tables.
- **BLOB storage** for `codehash` (32 B), `program` address (20 B), and
  `tx_hash` (32 B) instead of hex strings — storage per bid row drops by
  about 60% vs v1.
- **Idempotent writes** — every fact row has `UNIQUE(tx_hash, log_index)`
  and inserts use `INSERT OR IGNORE`. Re-running `sync` against the same
  range is a no-op.
- **Resumable backfill** — `sentinel sync` starts from
  `sync_meta.last_block + 1` when the DB is already partially populated,
  so re-starts are cheap.
- **Gap tracking** — any batch that fails after retries is recorded in the
  `sync_gaps` table so reconciliation can surface it.
- **Config events** — `SetCacheSize`, `SetDecayRate`, `Pause`, `Unpause`
  are persisted alongside bids/evictions; the M4 bidding agent will use
  them to model the decay curve over time.
- **Reconcile command** — compares the DB-derived "currently cached" set
  and total queue size against `CacheManager.getEntries()` and
  `queueSize()`, plus checks live `decay` / `cacheSize` / `isPaused`
  against the latest config event, and reports any recorded sync gaps.
- **Smoke tests** — `node:test` suite covering `parseEvents` and the
  bid / evict / rebid derivation logic in `getCurrentlyCached`.

### Not yet implemented (M3+)

No wallet integration, no cross-platform packaged CLI binary, no automatic
bid submission, no multi-contract management loop, no alerting. Those are
scoped for M3 and M4. See the [Roadmap](#roadmap).

---

## Architecture

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
                 |     - INSERT OR IGNORE on bids / evictions / config_events       |
                 |     - update sync_meta.last_block                                |
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

### Components

| Module                     | Responsibility                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/abi.ts`               | Minimal ABI slices for `ArbWasmCache` and `CacheManager` (events + reads used by the indexer).            |
| `src/provider.ts`          | Singleton viem `PublicClient`, configured from `ARB_RPC_URL`.                                             |
| `src/config.ts`            | `.env`-driven config (RPC URL, DB path, batch size, poll interval).                                        |
| `src/resolver.ts`          | `allCacheManagers()` lookup — returns the currently active `CacheManager` address.                        |
| `src/indexer/state.ts`     | Parallel reads of `cacheSize`, `queueSize`, `decay`, `isPaused`.                                           |
| `src/indexer/backfill.ts`  | Paged historical scan, resume-from-`last_block`, retry with gap recording on persistent RPC failure.      |
| `src/indexer/tail.ts`      | Poll loop for new events after backfill.                                                                   |
| `src/indexer/format.ts`    | `parseEvents()` turns raw `Log[]` into typed `ParsedBid` / `ParsedEviction` / `ParsedConfigEvent` arrays. |
| `src/indexer/reconcile.ts` | Compares DB-derived state to on-chain state; the data-integrity KPI lives here.                           |
| `src/db/schema.ts`         | v2 schema + auto-drop of v1 legacy tables.                                                                 |
| `src/db/store.ts`          | Connection, dim upserts, transactional `persistParsedEvents`, analytics queries.                           |
| `src/index.ts`             | CLI entry — `sync`, `status`, `reconcile`.                                                                 |
| `test/smoke.test.ts`       | `node:test` smoke suite (parseEvents + bid/evict/rebid derivation).                                        |

### Data flow — one `sync` run

1. `resolveCacheManager()` asks `ArbWasmCache` for the current manager.
2. `getDb()` opens SQLite, runs `initSchema` (auto-migrates v1 → v2 if
   the DB is from M1), and ensures `schema_version = 2`.
3. `backfill()` starts at `max(fromBlock, sync_meta.last_block + 1)`. For
   each `getLogs` batch:
   - decode via `parseEvents()`,
   - fetch block timestamps,
   - open a single transaction that upserts programs / codehashes,
     INSERT-OR-IGNOREs the facts, and advances `sync_meta.last_block`,
   - on persistent RPC failure, record the range in `sync_gaps`.
4. When backfill reaches head, `startTail()` takes over and repeats the
   same parse → persist cycle on each poll.
5. `reconcile` can be run at any time; it does not need `sync` to be
   running.

### Schema (v2)

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

sync_gaps     (from_block, to_block, reason, recorded_at)
sync_meta     (key, value)   -- includes schema_version, last_block
```

"Currently cached" is a derived view, not a column: for each codehash,
take its latest bid; if there is no eviction with a strictly later
`(block_number, log_index)` it is still cached. This mirrors how the
on-chain `CacheManager` determines occupancy and is what the reconcile
command compares to `getEntries()`.

---

## Tech stack

- **TypeScript** (strict, ES2022, CommonJS) — runs under `ts-node` in dev,
  compiled to `dist/` for production.
- **[viem](https://viem.sh/)** — chain client, ABI parsing, log decoding,
  ABI-parameter encoding for tests.
- **[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)** —
  synchronous SQLite bindings. Chosen over `sqlite3` / Prisma because the
  indexer is a single-process, tight-loop batch writer; synchronous prepared
  statements inside one transaction are the simplest way to get strong
  throughput and strict idempotency (`INSERT OR IGNORE` inside a tx).
- **dotenv** — `.env` loading.
- **chalk** — CLI output.
- **node:test** — zero-dependency test runner (Node 20+).

No ORM, no migration framework, no service workers: everything is a
TypeScript module calling a SQLite file. The schema migration is handled
inline in `initSchema` via a `schema_version` sentinel plus a drop-and-
recreate path for the (pre-release) v1 schema.

---

## Getting started

### Requirements

- Node.js 20+ (for the built-in test runner).
- An Arbitrum RPC endpoint. The public `https://arb1.arbitrum.io/rpc` works
  for low-volume testing; expect rate limits on a full backfill from the
  Stylus genesis block. Use an Alchemy / Infura / self-hosted RPC for real
  runs.

### Install

```bash
git clone https://github.com/SOMMIERSHOP/stylus-cache-sentinel.git
cd stylus-cache-sentinel
npm install
```

### Configure

```bash
cp .env.example .env
# edit .env:
#   ARB_RPC_URL=https://arb1.arbitrum.io/rpc
#   DB_PATH=./sentinel.db
```

### Run

```bash
# one-shot: check live on-chain cache state
npm run status

# full backfill from Stylus genesis, then live tail
npm run sync

# compare the DB against on-chain; exits 1 on drift
npm run reconcile

# smoke tests (no RPC required)
npm test
```

---

## Commands

| Command                  | What it does                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `sentinel sync`          | Resumes backfill from the last checkpoint, then switches to a live tail. Safe to stop and restart.                        |
| `sentinel status`        | Pretty-prints live `CacheManager` state: total cache size, used, free, decay rate, paused flag.                          |
| `sentinel reconcile`     | Computes the DB-derived currently-cached set and total size, compares against `getEntries()` / `queueSize()`, prints drift and any sync gaps. Exits 0 on match, 1 on drift. |

---

## Roadmap

| Milestone | Scope                                                    | Status                         |
| --------- | -------------------------------------------------------- | ------------------------------ |
| M1        | Indexer core + local DB                                  | **Shipped**                    |
| M2        | Data transformation + schema enhancement + integrity     | **Shipped**                    |
| M3        | CLI (wallet, config, cross-platform packaging)           | Planned                        |
| M4        | Sentinel monitoring / automated bidding                  | Planned                        |
| M5        | Full documentation                                       | Partial (this README)          |
| M6        | Mainnet deployment + 50-contract production target       | Planned                        |

### M3 — CLI

Commands for manual operations (`bid`, `withdraw`, `inspect <program>`),
wallet integration (encrypted keystore or external signer), structured
config in `~/.sentinel/config.json` or project-local, prebuilt binaries for
Linux / macOS / Windows.

### M4 — Sentinel (the automation loop)

- Watchlist of programs the operator wants cached.
- Continuous minimum-bid computation using `getMinBid()` plus the
  decay curve reconstructed from `config_events`.
- Automatic resubmission before eviction, with configurable headroom and
  cost caps.
- Multi-contract scheduling so one process can cover an entire protocol.
- Fail-safes: dry-run mode, max spend per window, halt on reconcile drift.

### M5 — Documentation

Quick-start, architecture deep-dive, configuration reference, extension
points for contributors.

### M6 — Mainnet launch

End-to-end tests against Arbitrum One, production packaging, real-user
onboarding toward the grant KPI of 50 cached contracts.

---

## Project status vs. grant KPIs

| KPI                                                                     | Target               | Current state                                                                          |
| ----------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| Indexer startup time (M1)                                               | < 30 s               | Cold start is SQLite open + one `allCacheManagers` RPC call; well under target.         |
| Event sync accuracy (M1)                                                | 100% vs on-chain     | Enforced by `reconcile`: byte-level `queueSize` + set comparison to `getEntries()`.     |
| Data latency (M1)                                                       | < 15 s               | Bounded by `pollIntervalMs` (default 4 s) plus one `getLogs` round-trip.                |
| Schema efficiency (M2)                                                  | ≥ 30% vs v1          | BLOB + FK normalization removes ~60% of per-row bytes in `bids`.                        |
| Data integrity (M2)                                                     | Zero loss            | `UNIQUE(tx_hash, log_index)` + transactional writes + `sync_gaps` + reconcile command.  |

---

## Repository layout

```
src/
  abi.ts                  ABI slices (ArbWasmCache + CacheManager)
  config.ts               env loading
  provider.ts             viem PublicClient
  resolver.ts             active CacheManager lookup
  types.ts                shared types
  indexer/
    backfill.ts           historical paged scan, resumable
    tail.ts               live poll loop
    format.ts             parseEvents + pretty-printer
    state.ts              live on-chain state reader
    reconcile.ts          DB-vs-chain drift report
  db/
    schema.ts             v2 schema + v1 auto-drop
    store.ts              connection + upserts + persist + queries
  index.ts                CLI entry (sync / status / reconcile)

test/
  smoke.test.ts           parseEvents + getCurrentlyCached coverage

tsconfig.json             prod build (rootDir = src/)
tsconfig.test.json        test type-check (includes test/)
```

---

## Funding

Developed under an Arbitrum Foundation grant ($36,500, six milestones over
six months). Resubmission of an earlier proposal whose original signing key
could not be recovered; see the grant application for full context.

## License

TBD (will be set at M6 mainnet launch).
