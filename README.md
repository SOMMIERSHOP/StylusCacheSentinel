# Stylus Cache Sentinel

Sentinel keeps your Arbitrum Stylus contracts cached, with nobody watching.

It indexes the on-chain
[`CacheManager`](https://docs.arbitrum.io/stylus/concepts/stylus-cache-manager)
bid and eviction feed into a local SQLite copy. It checks that copy against the
live chain. Then it bids on your behalf, on a timer, so your cache slot never
lapses.

The work is funded by an Arbitrum Foundation grant, across six milestones.
**Milestones 1–4 are shipped.** This documentation set is Milestone 5.

---

## Why

Arbitrum Stylus lets you ship WASM contracts in Rust, C, and C++. A compiled
program has to sit in the `ArbWasmCache` to run cheaply. If it drops out, every
call pays the full activation cost again.

Slots are won by bid. Anyone can stake ETH to hold one. Bids decay as time
passes. When the cache is full, the lowest bid is dropped to make room.

So holding a slot by hand is a chore. You watch for evictions. You work out the
new floor, which keeps moving as bids decay. You bid again before your slot
lapses. Then you do it all again, for every contract, forever.

Sentinel runs that loop for you. It starts in dry-run mode. Every spend clears a
stack of caps before any ETH moves.

---

## Quick start

```bash
git clone https://github.com/SOMMIERSHOP/stylus-cache-sentinel.git
cd stylus-cache-sentinel
npm install
cp .env.example .env          # set ARB_RPC_URL

npm run status                # check live cache state (one RPC call)
npm test                      # unit tests, no RPC required

sentinel config init                              # create ~/.sentinel/config.json
sentinel watch add 0xYourProgram --max-bid 0.01   # watch a target
sentinel run --once                               # dry-run a single pass
```

Full walkthrough: **[docs/quickstart.md](./docs/quickstart.md)**.

---

## Documentation

| Guide | What's in it |
| ----- | ------------ |
| [Installation](./docs/installation.md) | Requirements, build, environment setup. |
| [Quickstart](./docs/quickstart.md) | Fresh clone → running sentinel loop, step by step. |
| [Configuration](./docs/configuration.md) | Every `.env` var and `~/.sentinel/config.json` key. |
| [Commands](./docs/commands.md) | Full reference for every command and flag. |
| [Architecture](./docs/architecture.md) | System design, data flow, and the v2 schema. |
| [Bidding logic](./docs/bidding.md) | Decay-space accounting, decision policy, fail-safes. |
| [Deployment](./docs/deployment.md) | Running Sentinel as a container service. |
| [Troubleshooting](./docs/troubleshooting.md) | RPC limits, `ProgramExpired`, reconcile drift, and more. |
| [Contributing](./CONTRIBUTING.md) | Dev setup and project conventions. |

---

## What's shipped

- **Indexer (M1)** — discovers both the chain and the active `CacheManager` from
  the RPC, so the same build runs on Arbitrum One, Nova, and Orbit chains.
  Backfills events from Stylus genesis to head in resumable paged batches, then
  tails live.
- **Transformation & integrity (M2)** — normalized v2 schema with BLOB storage,
  cutting roughly 60% of the bytes per row against the v1 hex layout
  ([details](./docs/architecture.md#data-transformation--integrity-m2)).
  Idempotent `INSERT OR IGNORE` writes, gap tracking, and a `reconcile` command
  that byte-checks the DB against `getEntries()`.
- **CLI (M3)** — subcommand CLI with a validated user config, watchlist, and
  env-only wallet signing. Cross-platform on Node 20+, verified by CI on Linux,
  macOS, and Windows.
- **Sentinel (M4)** — the autonomous monitor/bidder: correct decay-inflated bid
  accounting, a pure unit-tested decision policy, Multicall3 read batching, an
  ordered fail-safe stack (per-bid ceiling, per-window spend cap, cooldown,
  dry-run default, halt-on-drift), and a full audit trail.

The [architecture guide](./docs/architecture.md) covers the design. The
[bidding guide](./docs/bidding.md) covers the math.

---

## Roadmap

| Milestone | Scope | Status |
| --------- | ----- | ------ |
| M1 | Indexer core + local DB | **Shipped** |
| M2 | Data transformation + schema + integrity | **Shipped** |
| M3 | CLI (wallet, config, cross-platform) | **Shipped** |
| M4 | Sentinel monitoring / automated bidding | **Shipped** |
| M5 | Full documentation | **This release** |
| M6 | Mainnet deployment + 50-contract production target | E2E validation and container packaging shipped; monitoring and adoption target outstanding |

---

## Project status vs. grant KPIs

We deliberately do not print current scores in this table. A number pasted into
a README goes stale the next time anyone edits a file, and a stale number is
worse than none. Run the check instead.

Most rows below are executable: the command prints the measured value and exits
non-zero if the target is missed, so it works as a CI gate. The rest are
configured bounds or structural properties of the design rather than live
metrics. Those rows say so plainly and point at the setting or the document
that defines them.

| KPI | Target | Run this to check it |
| --- | ------ | -------------------- |
| Indexer startup time (M1) | < 30 s | `npm run test:e2e` — asserts the budget and prints the measured time. |
| Event sync accuracy (M1) | 100% vs on-chain | `sentinel reconcile` — diffs the derived set against `getEntries()` and exits non-zero on any drift. |
| Data latency (M1) | < 15 s | Set by the tail poll interval: `pollIntervalMs` in `src/config.ts` (4 s), plus one `getLogs` round-trip. |
| Schema efficiency (M2) | ≥ 30% vs v1 | Structural, not a live metric — BLOB keys and FK normalization, described in [Architecture](./docs/architecture.md#data-transformation--integrity-m2). The v1 schema is gone, so there is nothing left to re-measure against. |
| Data integrity (M2) | Zero loss | `npm test` and `npm run test:e2e` — the E2E suite re-offers real mainnet logs and asserts every row is deduped, zero inserted. |
| Command coverage (M3) | 100% of services | `sentinel help` lists every command; each is documented in the [Command reference](./docs/commands.md). |
| Configuration accuracy (M3) | 100% validated | `npm test` — config validation is enforced on write *and* load, with rejection cases covered. |
| Cross-platform (M3) | Linux / macOS / Windows | CI: `.github/workflows/ci.yml`, matrix over all three on Node 20 and 22. |
| Sentinel startup (M4) | < 20 s | `npm run test:e2e` asserts the budget; `sentinel run` also logs `startup completed in …` every run. |
| Cache-expiration detection (M4) | < 10 s | Set by the loop poll interval: `pollIntervalMs` in the user config (5 s default). |
| Doc coverage (M5) | ≥ 80% of functions | `npm run docs:coverage` |
| Doc readability (M5) | Flesch ≥ 60 | `npm run docs:readability` |
| Dependency security | No high/critical | `npm audit --audit-level=high`, enforced in CI. |
| Production validation (M6) | End-to-end on mainnet | `npm run test:e2e` — full stack against Arbitrum One, read-only and dry-run throughout. |

`npm run docs:check` runs both M5 checks together.

---

## Funding

Built under an Arbitrum Foundation grant. The award is $36,500, split across six
milestones over six months. This is a resubmission: the key that signed the
first proposal could not be recovered. The grant application has the full story.

## License

Not set yet. We will pick one at the M6 mainnet launch.
