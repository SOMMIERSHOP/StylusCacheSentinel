# Command reference

Every command is invoked as `sentinel <command>` (or `npm run <script>`, or
`ts-node src/index.ts <command>` in dev — see
[Installation](./installation.md#running-the-cli)).

A `<target>` is either a **program address** (20-byte hex) or a **codehash**
(32-byte hex). A program is resolved to its codehash from the indexer DB first,
then from on-chain account code.

Flag syntax accepted by the parser: `--key value`, `--key=value`, and bare
`--flag` booleans.

---

## Indexer (M1 / M2)

### `sentinel sync`
Resolve the active `CacheManager`, backfill historical events from the Stylus
genesis block to head in paged batches, then switch to a live tail. Resumable —
safe to stop (`Ctrl-C`) and restart; it continues from the last checkpoint.
Persistent RPC failures on a range are recorded in `sync_gaps` and skipped
rather than aborting the run.

```bash
sentinel sync
```

### `sentinel status`
Print live on-chain `CacheManager` state: total cache size, used, free, decay
rate, and paused flag. One RPC round-trip; no DB required.

```bash
sentinel status
```

### `sentinel reconcile`
Compute the DB-derived currently-cached set and total queue size, compare
against `getEntries()` / `queueSize()`, check live `decay` / `cacheSize` /
`isPaused` against the latest config event, and report any recorded sync gaps.

**Exit code:** `0` on match, `1` on drift — usable as a CI / cron integrity
gate.

```bash
sentinel reconcile
```

---

## Configuration (M3)

### `sentinel config init [--force]`
Write a default config to `~/.sentinel/config.json`. Fails if one already
exists unless `--force` is given.

### `sentinel config show`
Print the active, validated config.

### `sentinel config set <key> <value>`
Set and validate a single config value. See the
[Configuration manual](./configuration.md#settable-keys-config-set-key-value)
for the settable keys.

```bash
sentinel config set defaultPolicy.headroomPercent 30
```

### `sentinel config path`
Print the absolute path of the config file.

---

## Watchlist (M3)

### `sentinel watch add <target> [--label <s>] [--max-bid <eth>] [--headroom <pct>]`
Add a program or codehash to the watchlist, with optional per-target overrides.
Warns if you add a codehash-only target (monitor-only until indexed). Creates a
default config first if none exists.

```bash
sentinel watch add 0xProgram… --label my-dex --max-bid 0.02 --headroom 25
```

### `sentinel watch remove <target>`
Remove a target by program address or codehash.

### `sentinel watch list`
List all watched targets with their overrides.

---

## Wallet (M3)

Reads the signer from the `SENTINEL_PRIVATE_KEY` environment variable. Both
subcommands error if it is not set.

### `sentinel wallet address`
Print the active signer address.

### `sentinel wallet balance`
Print the signer address and its ETH balance.

---

## Inspect & manual ops (M3)

### `sentinel inspect <target>`
Show, for one target: program (if known), codehash, whether it's cached, the
current minimum bid, our standing bid (if in the queue), and the entry size.
If `getMinBid` reverts (e.g. `ProgramExpired`), the min bid is shown as
`n/a (<reason>)` instead of crashing.

```bash
sentinel inspect 0xProgram…
```

### `sentinel bid <target> [--amount <eth>] [--yes]`
Manually place a single bid. **Dry-run unless `--yes`.** Without `--amount`, the
bid is the recommended bid (min bid + default headroom). Requires a program
address (a codehash-only target can't be bid on). Live submission needs
`SENTINEL_PRIVATE_KEY`; the command waits for the receipt and reports
confirmed / reverted.

```bash
sentinel bid 0xProgram…                 # dry-run at the recommended amount
sentinel bid 0xProgram… --amount 0.01 --yes   # submit exactly 0.01 ETH
```

### `sentinel history [--limit <n>]`
Print recent bid actions from the audit log (`bid_actions`): timestamp, status,
amount, target, and reason. Default limit 20.

```bash
sentinel history --limit 50
```

---

## Sentinel automation (M4)

### `sentinel run [--live] [--once] [--dry-run]`
The autonomous monitoring + bidding loop over the whole watchlist. Each tick
reads live cache state, assesses every target, and (in live mode) bids where
the [decision policy](./bidding.md#2-the-decision-policy) calls for it.

| Flag | Effect |
| ---- | ------ |
| *(none)* | Continuous **dry-run** — reads and decides, but never sends a transaction. |
| `--once` | Run a single pass, then exit (useful under cron). |
| `--live` | Opt in to spending real ETH. Refuses to start without `SENTINEL_PRIVATE_KEY`. |
| `--dry-run` | Force dry-run even alongside `--live`. |

```bash
sentinel run --once      # single dry-run pass
sentinel run             # continuous dry-run
sentinel run --live      # continuous, real bids (with all fail-safes)
```

Stops cleanly on `SIGINT` / `SIGTERM`.

### `sentinel health [--json]`

Reports whether the `run` loop is still ticking, and exits `1` if it is not.

The loop stamps a heartbeat as it works. `health` compares that timestamp
against the poll interval and calls the loop wedged once it has missed several
ticks in a row. A tick that simply ran long does not count as wedged.

The threshold never drops below `1.5 ×` the bid confirmation timeout, so a live
bid waiting on a slow receipt can never be mistaken for a stall. Progress is
also recorded per bid and per batch of reads rather than only at the end of a
tick, so a tick containing several live bids does not accumulate its way past
the limit.

```bash
sentinel health          # human-readable, exit 0 or 1
sentinel health --json   # machine-readable, same exit code
```

The check reads one local file. It makes no RPC call and does not open the
database, so a chain outage cannot mark a loop unhealthy for correctly riding
that outage out. This is the command the container `HEALTHCHECK` runs — see
[Deployment](./deployment.md).

A tick that throws still records a heartbeat. Per-tick errors are caught and
logged by design, so the condition being reported here is that ticks stopped
happening at all, not that one of them failed.

---

## Help

```bash
sentinel                 # prints usage
sentinel help
sentinel --help
sentinel -h
```

An unknown command prints usage and exits `1`.
