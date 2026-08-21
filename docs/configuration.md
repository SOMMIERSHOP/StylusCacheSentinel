# Configuration manual

Sentinel reads settings from two places.

1. **Environment (`.env`)** — the chain endpoint, the database path, and the
   signing key. Loaded by `src/config.ts`.
2. **User config (`~/.sentinel/config.json`)** — the policy, spend caps, and
   watchlist for the automation layer. Managed by `src/cli/userConfig.ts` and
   the `config` and `watch` commands.

Every value in the user config is checked **on write and again on load**. A bad
value is rejected outright. It is never quietly applied.

---

## 1. Environment variables (`.env`)

| Variable | Default | Required | Purpose |
| -------- | ------- | -------- | ------- |
| `ARB_RPC_URL` | `https://arb1.arbitrum.io/rpc` | No | Arbitrum RPC endpoint for all indexer + chain reads. Use a private RPC for real backfills. |
| `DB_PATH` | `./sentinel.db` (relative to build dir) | No | Path to the SQLite replica. |
| `SENTINEL_PRIVATE_KEY` | — | Only for live bids | 32-byte hex private key (with or without `0x`) for the signer. **Read from env only; never written to disk.** Needed for `run --live` and `bid --yes`. |
| `SENTINEL_HOME` | `~/.sentinel` | No | Directory for the user config file. Handy for isolating environments (the test suite uses it). |

> **Which RPC wins.** If the user config sets `rpcUrl`, it beats `ARB_RPC_URL`.
> Sentinel applies it at startup, before it builds any client. This is the
> intended way to point the tool at an Orbit chain. If you set neither, the
> built-in default is used.

> **The chain follows the RPC.** Sentinel does not assume Arbitrum One. On
> startup it asks the endpoint for its chain id and adopts whatever it reports.
> A known id (One, Nova, Sepolia) resolves to that chain; any other id is
> treated as an Orbit chain. This matters for live bidding, because a
> transaction signed for the wrong chain id is rejected outright. Run
> `sentinel status` and check the `Chain:` line to confirm where you are
> pointed.

### Static constants (not env-configurable)

These are code constants in `src/config.ts`.

- `arbWasmCacheAddress` = `0x…0072` — the `ArbWasmCache` precompile, fixed on
  every Arbitrum chain.
- `batchSize` = `2000` — blocks per `getLogs` batch during backfill.
- `pollIntervalMs` = `4000` — the **indexer tail** poll interval. (Distinct
  from the *sentinel loop* poll interval below.)

---

## 2. User config (`~/.sentinel/config.json`)

Create it with `sentinel config init`. Read it back with `sentinel config show`.
Change a value with `sentinel config set <key> <value>`. The watchlist is the
one exception: use the `watch` commands for it, not `config set`.

### Full shape and defaults

```jsonc
{
  "rpcUrl": undefined,               // optional RPC override (falls back to ARB_RPC_URL)
  "pollIntervalMs": 5000,            // sentinel loop tick (ms)
  "defaultPolicy": {
    "maxBidEth": "0.01",             // per-bid ceiling (ETH string)
    "headroomPercent": 20            // target margin over the min bid (%)
  },
  "maxSpendPerWindowEth": "0.05",    // spend cap per rolling window (ETH string)
  "spendWindowHours": 24,            // length of the spend window (hours)
  "haltOnDrift": false,              // refuse to bid while reconcile reports drift
  "bidCooldownSeconds": 300,         // min seconds between actions on one target
  "watchlist": []                    // managed via `sentinel watch`
}
```

### Settable keys (`config set <key> <value>`)

| Key | Type / rule | Default | Meaning |
| --- | ----------- | ------- | ------- |
| `rpcUrl` | `http(s)://` or `ws(s)://` URL | (unset) | Overrides `ARB_RPC_URL`. Use for Orbit chains. |
| `pollIntervalMs` | positive integer (ms) | `5000` | How often the `run` loop ticks. Bounds cache-expiration detection latency. |
| `defaultPolicy.maxBidEth` | decimal ETH string | `"0.01"` | Ceiling for any single bid, unless a target overrides it. |
| `defaultPolicy.headroomPercent` | number `0`–`10000` | `20` | Target margin over the on-chain min bid. Applied in basis points. |
| `maxSpendPerWindowEth` | decimal ETH string | `"0.05"` | Total spend allowed within one window. |
| `spendWindowHours` | positive integer | `24` | Rolling spend-window length. |
| `haltOnDrift` | `true` / `false` | `false` | In live mode, skip bidding on any tick where `reconcile` finds DB-vs-chain drift. |
| `bidCooldownSeconds` | positive integer | `300` | Minimum seconds between actions on the same target (anti-spam / anti duplicate-submit). |

Examples:

```bash
sentinel config set defaultPolicy.headroomPercent 30
sentinel config set maxSpendPerWindowEth 0.1
sentinel config set haltOnDrift true
sentinel config set rpcUrl https://my-orbit-chain.example/rpc
```

Every `set` re-checks the whole config. If the result is invalid, nothing is
saved.

---

## 3. Watchlist targets

Each watchlist entry names a program **or** a codehash, never both. You can add
per-target overrides too. Manage entries with `sentinel watch`.

```bash
sentinel watch add <program|codehash> [--label <s>] [--max-bid <eth>] [--headroom <pct>]
sentinel watch remove <program|codehash>
sentinel watch list
```

| Field | Set via | Rule | Meaning |
| ----- | ------- | ---- | ------- |
| `program` | positional (20-byte hex) | valid address | The Stylus program to keep cached. **Required to bid** (`placeBid` is address-keyed). |
| `codehash` | positional (32-byte hex) | 66-char hex | Alternative target key. Monitor-only until the indexer can map it to a program. |
| `label` | `--label` | any string | Friendly name in logs. Defaults to a shortened hex. |
| `maxBidEth` | `--max-bid` | decimal ETH string | Overrides `defaultPolicy.maxBidEth` for this target. |
| `headroomPercent` | `--headroom` | number `0`–`10000` | Overrides `defaultPolicy.headroomPercent` for this target. |

> **Program or codehash?** Add **program addresses** when you can. Sentinel can
> watch a codehash-only target, but it cannot bid on one. `placeBid` needs the
> address. To get it, run `sentinel sync` and let the indexer map the codehash
> back to its program. `watch add` warns you when a target is codehash-only.

---

## Interaction with the fail-safes

Several of these values feed straight into the
[bidding fail-safes](./bidding.md#3-the-fail-safe-stack).

- `maxBidEth` (per target or default) → **per-bid ceiling**.
- `maxSpendPerWindowEth` + `spendWindowHours` → **per-window spend cap**.
- `bidCooldownSeconds` → **cooldown** between actions on one target.
- `haltOnDrift` → **halt-on-drift** guard.

Start low. Set a small `maxBidEth` and a small `maxSpendPerWindowEth`. Watch a
few dry-run cycles of `sentinel run`, and read `sentinel history`. Once the
behavior matches what you expect, raise the caps.
