# Contributing

Thanks for your interest in Stylus Cache Sentinel. This guide covers the dev
setup, project conventions, and where things live so you can make a change with
confidence.

## Development setup

```bash
git clone https://github.com/SOMMIERSHOP/stylus-cache-sentinel.git
cd stylus-cache-sentinel
npm install
cp .env.example .env      # set ARB_RPC_URL
```

Requirements: **Node.js 20+** and an Arbitrum RPC endpoint. See
[docs/installation.md](./docs/installation.md) for details.

### Everyday commands

| Command | What it does |
| ------- | ------------ |
| `npm run build` | Compile `src/` → `dist/` with `tsc`. |
| `npm test` | Run the offline `node:test` suite (no RPC required). |
| `npm run test:e2e` | Build, then run the M6 end-to-end suite against Arbitrum One (needs an RPC). |
| `npm run docs:check` | Check inline doc coverage and prose readability against the M5 targets. |
| `npm run dev -- <command>` | Run the CLI from source via `ts-node`. |
| `npm run sync` / `status` / `reconcile` | Indexer commands (need an RPC). |
| `npm run run-sentinel` | The sentinel loop (dry-run by default). |

Running the CLI from source without building:

```bash
ts-node src/index.ts <command>
```

## Before you open a PR

1. `npm run build` — must compile clean (the project is `strict`).
2. `npm run typecheck` — type-checks `src/` *and* `test/`.
3. `npm test` — all tests must pass.
4. `npm run docs:check` — doc coverage and readability must stay above target.
5. If you touched chain-facing logic, run `npm run test:e2e` against a real RPC.
   It is read-only and dry-run throughout, so it cannot spend.

CI runs steps 1–4 on Linux, macOS, and Windows across Node 20 and 22, plus
`npm audit`. The E2E suite runs nightly and on demand, not per pull request,
because it depends on a public RPC.

## Code conventions

- **TypeScript, strict mode, ES2022, CommonJS.** No `any` unless narrowing a
  viem error; prefer typed reads.
- **Keep the npm scripts shell-agnostic.** They have to run under `cmd.exe` as
  well as a POSIX shell, so no `VAR=value` command prefixes and no shell globs.
  That is why the test scripts list their files explicitly — add new test files
  to the list in `package.json`.
- **Never hardcode a chain.** The chain comes from the RPC via
  `resolveChain()`. A transaction signed for the wrong chain id is rejected, so
  a hardcoded chain silently breaks every Nova and Orbit deployment.
- **Comment voice:** terse and precise. Explain *why*, not *what* — the repo
  favors short comments that capture a non-obvious invariant (see the decay-
  space notes in `src/sentinel/assess.ts` for the house style).
- **Public API gets JSDoc.** Every exported function / class / interface / type
  carries a `/** … */` block, and each module has a `@module` header. Keep this
  up as you add exports.
- **Keep decision logic pure.** The bid math (`computeBidDecision`,
  `recommendedBid`) is deliberately free of chain/DB calls so it can be unit-
  tested exhaustively. New decision logic should follow suit and come with
  tests in `test/sentinel.test.ts`.
- **Idempotency is a feature.** Anything that writes to the DB must be safe to
  re-run (`INSERT OR IGNORE` on `UNIQUE(tx_hash, log_index)`); don't add write
  paths that break `sync` re-runs.
- **Safety first in the bidder.** New behavior around spending must respect the
  ordered [fail-safe stack](./docs/bidding.md#3-the-fail-safe-stack) and default
  to dry-run.

## Where things live

See [docs/architecture.md → Repository layout](./docs/architecture.md#repository-layout)
for the full map. In short:

- `src/indexer/` — event scan, parse, tail, reconcile.
- `src/db/` — schema + SQLite persistence.
- `src/cli/` — arg parsing + user config.
- `src/sentinel/` — assessment, bidding, and the run loop.
- `src/index.ts` — CLI entry / command router.
- `test/` — offline `node:test` suites (smoke, cli, sentinel).
- `test/e2e/` — the mainnet end-to-end suite.
- `scripts/` — the M5 documentation KPI checkers.
- `Dockerfile`, `docker-compose.yml` — the deployable image; see
  [docs/deployment.md](./docs/deployment.md).

## Tests

There are two suites, and both use the built-in `node:test` runner (Node 20+).

**Offline suite — `npm test`.** Needs no network. Add coverage next to the
module you change:

- `test/smoke.test.ts` — event parsing + `getCurrentlyCached` derivation.
- `test/cli.test.ts` — config validation + target classification.
- `test/sentinel.test.ts` — bid-decision math.

**End-to-end suite — `npm run test:e2e`.** This is the M6 production
validation, and it talks to Arbitrum One for real:

- `test/e2e/mainnet.test.ts` — CacheManager resolution, live state reads,
  backfill against a fixed historical window, dedup, reconcile drift detection,
  target resolution, live entry classification, a dry sentinel tick, the
  bidder's dry-run path, and CLI response times.

The E2E suite deletes `SENTINEL_PRIVATE_KEY` from its environment before
importing anything, so it cannot sign or spend even if your shell has a key
set. Keep that property if you add to it.

Both suites set `DB_PATH` and `SENTINEL_HOME` to temp paths, so they never
touch your real index or `~/.sentinel`. Follow that pattern in new tests.

Note that the E2E indexer tests pin a fixed, already-mined block window rather
than one relative to the chain head. CacheManager events are sparse — often
none in the last two million blocks — so a moving window would be flaky.

## Reporting issues

Please include: the command you ran, the RPC you used (public vs. private), the
relevant `sentinel history` / `sentinel reconcile` output, and your Node
version. For bidding questions, [docs/bidding.md](./docs/bidding.md) and
[docs/troubleshooting.md](./docs/troubleshooting.md) may already have the
answer.

## License

The project license will be finalized at the M6 mainnet launch; until then,
treat contributions as offered under the license that ships with that release.
