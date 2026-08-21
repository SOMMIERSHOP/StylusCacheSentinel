# Quickstart

This walks you from a fresh clone to a running sentinel loop that keeps a
Stylus contract cached — starting entirely in **dry-run**, so no ETH is spent
until you explicitly opt in.

If you haven't installed yet, do the [Installation](./installation.md) steps
first (`npm install`, `cp .env.example .env`, set `ARB_RPC_URL`).

---

## 1. Check you can reach the chain

```bash
npm run status
```

You should see the active `CacheManager` address and current cache
usage/decay. If this errors, fix your `ARB_RPC_URL` before continuing.

## 2. Build the local index (optional but recommended)

```bash
npm run sync
```

`sync` backfills historical `CacheManager` events from the Stylus genesis block
to head, then switches to a live tail. It is **resumable** — stop it with
`Ctrl-C` any time and re-run to continue from the last checkpoint.

Why it helps: the sentinel can bid only on targets for which it knows the
**program address** (`placeBid` is address-keyed). Indexing lets it map a
codehash back to its program. You can skip this if you only ever watch program
addresses directly, but syncing makes codehash-only targets biddable and powers
`reconcile`.

Let it run until you see `historical scan done, switching to live tail`, then
`Ctrl-C`. (For an integrity check afterwards, run `npm run reconcile`.)

## 3. Create your config and add a target

```bash
sentinel config init
sentinel watch add 0xYourStylusProgramAddress --max-bid 0.01 --headroom 25
```

- `--max-bid 0.01` caps any single bid for this target at 0.01 ETH.
- `--headroom 25` tells the sentinel to keep our bid ~25% above the eviction
  floor.

Confirm it's on the list:

```bash
sentinel watch list
```

## 4. Inspect the target on-chain

```bash
sentinel inspect 0xYourStylusProgramAddress
```

This prints whether the codehash is cached, the current minimum bid, our
standing bid (if any), and the entry size — a good sanity check before letting
the loop act.

## 5. Run the loop in dry-run

```bash
sentinel run --once      # a single pass, then exit
sentinel run             # continuous dry-run
```

In dry-run the sentinel does everything *except* send transactions: it reads
live state, runs the decision for each target, and logs what it **would** do,
recording each simulated action to the audit log. No wallet is needed.

Review what it decided:

```bash
sentinel history
```

## 6. Go live (when you're ready to spend)

Set a funded signer and opt in with `--live`:

```bash
# in .env (or the shell environment):
#   SENTINEL_PRIVATE_KEY=0x...

sentinel wallet balance   # confirm the signer address + ETH balance
sentinel run --live       # now real bids can be placed
```

Live mode refuses to start without `SENTINEL_PRIVATE_KEY`, and every bid still
passes the full [fail-safe stack](./bidding.md#3-the-fail-safe-stack):
per-bid ceiling, per-window spend cap, and cooldown.

---

## Where to go next

- **[Configuration manual](./configuration.md)** — tune headroom, spend caps,
  poll interval, and per-target overrides.
- **[Command reference](./commands.md)** — every command and flag.
- **[Bidding logic](./bidding.md)** — exactly when and how much the sentinel
  bids.
- **[Troubleshooting](./troubleshooting.md)** — RPC limits, `ProgramExpired`,
  reconcile drift.
