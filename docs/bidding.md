# Bidding logic

This is the most subtle part of the system, so it gets its own document. It
covers three things:

1. the **decay-inflated bid accounting** that `CacheManager` uses and how
   Sentinel normalizes it,
2. the **decision policy** — when the sentinel decides to (re)bid, and for how
   much,
3. the ordered **fail-safe stack** that stands between a decision and a real
   transaction.

The relevant code is `src/sentinel/assess.ts` (pure decision math) and
`src/sentinel/bidder.ts` (submission + fail-safes). The decision math is a
pure function and is exhaustively unit-tested in `test/sentinel.test.ts`.

---

## 1. Decay-inflated bid accounting

The single most important invariant in the codebase:

> `CacheManager` stores bids in a **decay-inflated space**, while `getMinBid()`
> returns a plain `msg.value`. To compare anything, you must convert both into
> the same space first.

Concretely:

- When you call `placeBid`, the contract records
  `stored = msg.value + block.timestamp * decay`. This is what
  `getEntries()` returns as each entry's `bid`.
- `getMinBid(codehash)`, by contrast, subtracts the current
  `block.timestamp * decay` back out and returns a plain **`msg.value`** — the
  amount you'd need to send *right now* to clear the eviction floor.

Because the inflation term grows every second, two bids placed with the same
`msg.value` at different times have different *stored* values, and a stored
value is not directly comparable to a `getMinBid` result.

**How Sentinel handles it.** Each tick, `buildTickContext` reads the current
block and computes:

```
decayOffsetWei = block.timestamp * decay
```

Then, for a target already in the queue, `assessTarget` converts our stored
bid back into `msg.value` space:

```
ourValueWei = entry.bidStoredWei - decayOffsetWei
```

Now `ourValueWei` and `minBidWei` (from `getMinBid`) are in the **same space**
and can be compared. Note that `ourValueWei` is a *comparison-only* quantity —
it can legitimately go negative (our bid has decayed below the current
baseline), and it is **never sent on-chain**. The value we actually submit is
always `recommendedBid()`.

---

## 2. The decision policy

`computeBidDecision(input)` is a pure function (no chain, no DB) that returns
`{ needsBid, recommendedBidWei, reason, blocked }`. All wei inputs are in
`msg.value` space. The policy, in order:

1. **Not cached → bid.** If the codehash isn't in the cache, place a bid to
   (re)insert it.
2. **Cached with free room → idle.** If the cache has space for this entry's
   size, nothing can force an eviction, so do nothing. (`hasFreeRoom` compares
   `freeBytes` to the entry `sizeBytes`.)
3. **Cached, contended, standing bid unknown → hold.** If the cache is full but
   we can't measure our margin (we're not in `getEntries()` yet), stay
   conservative and do nothing rather than risk an over-bid.
4. **Cached, contended, margin below headroom → rebid.** Compute our margin
   over the eviction floor (`ourValueWei − minBidWei`). If it has decayed below
   the target margin (`minBidWei × headroom%`), rebid to restore headroom.
5. **Otherwise → idle** with sufficient headroom.

### How much to bid — `recommendedBid`

```
recommendedBid(minBidWei, headroomPercent)
  = minBidWei + minBidWei × (headroomPercent basis points) / 10_000
```

Headroom is applied in **basis points** so fractional percentages (e.g.
`12.5%`) don't lose precision in BigInt math. The result is in `msg.value`
space, same as `minBidWei`.

One edge case: `recommendedBid` returns `0` only when the floor is `0` (free
space, or a decayed-to-zero floor). `computeBidDecision` floors a real bid to
**1 wei** in that case, so `placeBid` still re-baselines us and can't trip
`BidTooSmall` if the floor crept above 0 between the read and the tx landing.

### Multi-eviction correctness

`getMinBid` returns the **largest** stored bid among the entries that must be
evicted to fit our size — **not the sum**. `CacheManager._makeSpace` evicts
those entries one by one, each requiring `bid ≥ that threshold`, so a single
bid of `minBidWei` already clears the whole eviction set; the headroom only
adds margin. The residual risk is purely a read→land race: if a competitor
raises the threshold by more than our headroom between our read and our tx
landing, `placeBid` reverts `BidTooSmall`, which is recorded as a `failed`
outcome and retried next tick — never an overpay.

---

## 3. The fail-safe stack

`executeBid` applies every guard **in order** before a transaction is ever
sent. Each guard that stops a bid records the reason to `bid_actions` (visible
via `sentinel history`):

| # | Guard | Behavior |
| - | ----- | -------- |
| 0 | **Monitor-only** | `placeBid` is keyed on the program **address**. A target known only by codehash (no program recoverable from the indexer or chain) can be observed but never bid on. Outcome: `blocked`. |
| 1 | **Per-bid ceiling** | If `recommendedBid` exceeds the target's `maxBidEth` (per-target override or `defaultPolicy.maxBidEth`), skip and flag for manual attention. Outcome: `blocked`. |
| 2 | **Per-window spend cap** | If prior spend in the last `spendWindowHours` plus this bid would exceed `maxSpendPerWindowEth`, skip. In dry-run, prior dry-run rows are counted too, so a simulation surfaces when live mode *would* hit the cap. Outcome: `blocked`. |
| 3 | **Dry-run** | Unless `run --live`, never touch the chain — record what *would* happen. Outcome: `dry-run`. |
| 4 | **Live submit + confirm** | `placeBid` with `value = recommendedBid`, then `waitForTransactionReceipt`. Outcome: `submitted` → `confirmed` / `failed`. |

Additional loop-level safety nets in `sentinel/run.ts`:

- **Dry-run is the default.** `--live` is the only thing that spends real ETH,
  and live mode refuses to start without a funded `SENTINEL_PRIVATE_KEY`.
- **Cooldown** (`bidCooldownSeconds`, default 300) — after acting on a target,
  hold off before acting again. Prevents dry-run row spam and stops a still-
  pending live bid from being resubmitted on the next poll.
- **Halt on drift** (`haltOnDrift`, default off) — in live mode, run
  `reconcile` each tick and refuse to bid while the DB disagrees with the
  chain, so the sentinel never acts on a stale local view.
- **Program re-resolution** — the watchlist is periodically re-resolved so a
  redeploy / re-activation (which changes the codehash) is picked up without a
  restart.

---

## Activation vs. caching

A program that is **not Stylus-activated** (or whose activation has expired)
cannot be cached at all, and `getMinBid` reverts with `ProgramExpired` /
`ProgramNotActivated`. The sentinel detects these specific reverts and takes
**no action** — bidding can't fix an activation problem. The fix is to
re-activate the program on-chain first; see
[Troubleshooting](./troubleshooting.md#getminbid-reverts-programexpired--programnotactivated).
