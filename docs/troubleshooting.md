# Troubleshooting

Common failure modes and what to do about them. If your issue isn't here, run
the relevant command once more with a private RPC (many problems are public-RPC
rate limits) and check `sentinel history` / `sentinel reconcile` for context.

---

## RPC rate limits during `sync`

**Symptom:** the backfill slows to a crawl, logs skipped ranges, or you see
`sync_gaps` recorded when you run `reconcile`.

**Why:** a full backfill from the Stylus genesis block issues many `getLogs`
calls. The public `arb1.arbitrum.io/rpc` endpoint rate-limits aggressively.

**Fix:**
- Use a private RPC (Alchemy / Infura / self-hosted) via `ARB_RPC_URL` or
  `config set rpcUrl …`.
- Re-run `sentinel sync` — it resumes from the last checkpoint, and
  `INSERT OR IGNORE` makes re-indexing already-seen ranges a no-op. Recorded
  gaps are re-attempted on subsequent runs.

---

## `getMinBid` reverts: `ProgramExpired` / `ProgramNotActivated`

**Symptom:** `inspect` shows min bid `n/a (ProgramExpired)`; the sentinel logs
`program needs re-activation before it can be cached` and takes no action.

**Why:** the program's Stylus **activation** has lapsed (or it was never
activated). An unactivated program cannot be cached *at all*, and the sentinel
correctly refuses to bid — bidding cannot fix an activation problem.

**Fix:** re-activate the program on-chain (via `ArbWasm.activateProgram` / your
normal Stylus deployment tooling), then let the sentinel resume. It
periodically re-resolves the watchlist, so once activation is restored it will
pick the target back up without a restart. See
[Bidding logic → Activation vs. caching](./bidding.md#activation-vs-caching).

---

## A target is "monitor-only" and never gets bid on

**Symptom:** `history` shows `blocked` with "monitor-only: no program address
known for this codehash".

**Why:** you added a **codehash** to the watchlist, and the tool can't map it
back to a program address. `placeBid` is keyed on the program address, so a
codehash-only target can be observed but not bid on.

**Fix:**
- Run `sentinel sync` so the indexer records a bid that links the codehash to
  its program, **or**
- Add the **program address** to the watchlist instead of the codehash.

---

## Live mode won't start

**Symptom:** `run --live` throws "Live mode requires SENTINEL_PRIVATE_KEY".

**Fix:** set `SENTINEL_PRIVATE_KEY` in `.env` (or the shell), then confirm with
`sentinel wallet balance`. This guard is intentional — live mode never runs
without a signer.

---

## `reconcile` reports drift

**Symptom:** `sentinel reconcile` exits `1` and prints a queue-size delta,
entries missing from / extra in the DB, config drift, or sync gaps.

**What it means:** the DB-derived state disagrees with the chain. Common causes:
- the index is stale — you haven't `sync`ed recently;
- there are recorded `sync_gaps` from a rate-limited backfill;
- config events (decay / cache size / pause) changed on-chain since your last
  sync.

**Fix:** run `sentinel sync` to catch up, then `reconcile` again. If you run the
sentinel unattended and want it to refuse to act on a stale view, set
`config set haltOnDrift true` — in live mode it will skip bidding on any tick
where reconcile finds drift.

---

## Bids revert with `BidTooSmall`

**Symptom:** `history` shows a `failed` bid; logs mention `BidTooSmall`.

**Why:** a competitor raised the eviction floor between the sentinel's read and
its transaction landing (a read→land race), by more than your configured
headroom. This is expected and safe — it's a *revert*, not an overpay.

**Fix:** usually none — the sentinel retries on the next tick. If it recurs
often on a contended slot, raise that target's `--headroom` (or
`defaultPolicy.headroomPercent`) so the buffer absorbs more competitive
movement. Keep an eye on the per-bid ceiling and spend cap as you do.

---

## `better-sqlite3` fails to install / load

**Symptom:** `npm install` errors compiling a native addon, or a runtime
`Cannot find module` / ABI-version error for `better-sqlite3`.

**Fix:** ensure a C/C++ toolchain is present (Xcode CLT on macOS,
`build-essential` + `python3` on Debian/Ubuntu, VS Build Tools on Windows) and
that you're on Node 20+. Then `rm -rf node_modules && npm install` to rebuild
against your current Node ABI.

---

## Nothing happens in `run` (dry-run is silent about actions)

**Symptom:** `run` logs `cached … cache has free space` and never proposes a
bid.

**Why:** this is correct. While the cache has room for your entry's size,
nothing can force an eviction, so the [decision
policy](./bidding.md#2-the-decision-policy) idles. The sentinel only bids when
a target is not cached, or when the cache is full *and* your margin over the
floor has decayed below the headroom target.

---

## Bids fail on Nova or an Orbit chain

**Symptom:** reads work and `status` prints sane numbers, but a live `bid` or
`run --live` is rejected by the node before it lands.

**Why:** a transaction is signed for one specific chain id. If the signer and
the endpoint disagree, every submission bounces.

**Fix:** run `sentinel status` and read the `Chain:` line. It shows the chain
id the endpoint reported, and that is what Sentinel signs for. If it names the
wrong network, your `rpcUrl` points somewhere you did not intend — check the
user config first, since it overrides `ARB_RPC_URL`. An unrecognized id shows
up as `Orbit chain <id>`, which is expected on a custom chain and still signs
correctly.
