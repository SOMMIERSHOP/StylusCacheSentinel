import { test } from "node:test";
import assert from "node:assert/strict";

import {
  recommendedBid,
  computeBidDecision,
  isActivationError,
} from "../src/sentinel/assess";
import { toFunctionSelector } from "viem";
import { checkHealth, staleAfterMs, isWedged } from "../src/sentinel/heartbeat";
import { cacheManagerWriteAbi } from "../src/abi";
import { config } from "../src/config";

const MAX = 10_000n; // generous per-bid ceiling for most cases

// Helper: all wei values are in msg.value space (what getMinBid returns and
// what assessTarget converts our standing bid into).
function decide(over: Partial<Parameters<typeof computeBidDecision>[0]>) {
  return computeBidDecision({
    cached: true,
    minBidWei: 1000n,
    ourValueWei: 2000n,
    freeBytes: 0n,
    sizeBytes: 1000n,
    headroomPercent: 20,
    maxBidWei: MAX,
    ...over,
  });
}

test("recommendedBid applies headroom in basis points", () => {
  assert.equal(recommendedBid(0n, 20), 0n, "zero floor -> zero bid");
  assert.equal(recommendedBid(1000n, 20), 1200n, "20% headroom");
  assert.equal(recommendedBid(1000n, 12.5), 1125n, "fractional headroom");
  assert.equal(recommendedBid(1000n, 0), 1000n, "no headroom");
});

test("not cached -> always needs a bid", () => {
  const d = decide({ cached: false });
  assert.equal(d.needsBid, true);
  assert.equal(d.recommendedBidWei, 1200n);
  assert.equal(d.blocked, false);
});

test("cached with free room for our size -> no action", () => {
  // free space (99999) comfortably fits our size (1000) -> nothing to do
  const d = decide({ freeBytes: 99_999n, sizeBytes: 1000n });
  assert.equal(d.needsBid, false);
});

test("cached, contended, healthy margin -> no action", () => {
  // floor 1000, our value 2000 -> margin 1000 >= target 200 (20% of floor)
  const d = decide({ ourValueWei: 2000n });
  assert.equal(d.needsBid, false);
});

test("cached, contended, thin margin -> rebid", () => {
  // floor 1000, our value 1100 -> margin 100 < target 200 -> rebid
  const d = decide({ ourValueWei: 1100n });
  assert.equal(d.needsBid, true);
  assert.equal(d.recommendedBidWei, 1200n);
});

test("cached, contended, standing bid unknown -> hold (no over-bid)", () => {
  const d = decide({ ourValueWei: null });
  assert.equal(d.needsBid, false);
});

test("cached, contended, decayed below baseline (floor 0) -> rebid, floored to 1 wei", () => {
  // floor 0 (decayed), our value negative -> margin < 0 -> rebid.
  // recommendedBid(0,...) would be 0; we floor to 1 wei to avoid a literal
  // zero-value placeBid (BidTooSmall risk).
  const d = decide({ minBidWei: 0n, ourValueWei: -500n });
  assert.equal(d.needsBid, true);
  assert.equal(d.recommendedBidWei, 1n);
});

test("not cached with zero floor -> 1 wei insert, never literal zero", () => {
  const d = decide({ cached: false, minBidWei: 0n });
  assert.equal(d.needsBid, true);
  assert.equal(d.recommendedBidWei, 1n);
});

test("per-bid ceiling marks the decision blocked", () => {
  const d = decide({ cached: false, maxBidWei: 500n }); // recommended 1200 > 500
  assert.equal(d.needsBid, true);
  assert.equal(d.blocked, true);
});

// --- revert classification -------------------------------------------------
// A program blocked on Stylus re-activation is a routine, expected outcome, not
// an error: the sentinel must report it as "no action needed" rather than as a
// failed read, because no bid can resolve it.

test("isActivationError covers every re-activation revert", () => {
  assert.equal(isActivationError("ProgramExpired"), true);
  assert.equal(isActivationError("ProgramNotActivated"), true);
  assert.equal(isActivationError("ProgramNeedsUpgrade"), true);

  // Price-related reverts are NOT activation errors — those the sentinel can
  // and should act on by rebidding.
  assert.equal(isActivationError("BidTooSmall"), false);
  assert.equal(isActivationError("BidsArePaused"), false);
  assert.equal(isActivationError(null), false);
});

test("the CacheManager ABI decodes the reverts seen on mainnet", () => {
  // Selectors observed live on Arbitrum One. ProgramNeedsUpgrade (0x637d968f)
  // was absent from the ABI and degraded a routine outcome into an opaque
  // "read error" until it was added — this pins it.
  const observed: Record<string, string> = {
    "ProgramExpired(uint64)": "0xc9b12e52",
    "ProgramNotActivated()": "0x6f809c4e",
    "ProgramNeedsUpgrade(uint16,uint16)": "0x637d968f",
  };

  const declared = new Set<string>(
    cacheManagerWriteAbi
      .filter((e): e is Extract<typeof e, { type: "error" }> => e.type === "error")
      .map((e) => e.name)
  );

  for (const [signature, selector] of Object.entries(observed)) {
    const name = signature.slice(0, signature.indexOf("("));
    assert.ok(declared.has(name), `${name} must be declared in the ABI`);
    assert.equal(
      toFunctionSelector(signature),
      selector,
      `${signature} should hash to ${selector}`
    );
  }
});

// --- liveness --------------------------------------------------------------
// `restart: unless-stopped` only reacts to a process that exits. These cover
// the other failure mode: a loop still running but no longer ticking.

test("checkHealth reports unhealthy when no tick has ever completed", () => {
  const r = checkHealth(null, 1_000_000);
  assert.equal(r.ok, false);
  assert.equal(r.ageMs, null);
  assert.match(r.reason, /no heartbeat/);
});

test("checkHealth allows a tick that merely overran its interval", () => {
  const now = 1_000_000;
  // 5s poll -> 15s, but the floor is derived from the 120s receipt timeout.
  const r = checkHealth(
    { tickCompletedAtMs: now - 20_000, pollIntervalMs: 5_000 },
    now
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.staleAfterMs, 180_000, "short intervals must use the derived floor");
});

test("checkHealth flags a loop that stopped ticking", () => {
  const now = 1_000_000;
  const r = checkHealth(
    { tickCompletedAtMs: now - 400_000, pollIntervalMs: 5_000 },
    now
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /not progressing/);
});

test("checkHealth scales the limit with a slow poll interval", () => {
  const now = 10_000_000;
  const slow = 10 * 60_000; // 10 minute poll -> 30 minute limit
  assert.equal(staleAfterMs(slow), 30 * 60_000);

  // 25 minutes since the last tick is fine at this interval, but would be
  // wedged at the default one.
  assert.equal(
    checkHealth({ tickCompletedAtMs: now - 25 * 60_000, pollIntervalMs: slow }, now).ok,
    true
  );
  assert.equal(
    checkHealth({ tickCompletedAtMs: now - 25 * 60_000, pollIntervalMs: 5_000 }, now).ok,
    false
  );
});

test("checkHealth treats backwards clock skew as live, not wedged", () => {
  const now = 1_000_000;
  const r = checkHealth({ tickCompletedAtMs: now + 5_000, pollIntervalMs: 5_000 }, now);
  assert.equal(r.ok, true);
  assert.match(r.reason, /clock skew/);
});

// The watchdog exists because a restart policy reacts to a process that exits,
// never to one that is merely stuck. It shares checkHealth's threshold so
// "unhealthy" and "self-exit" cannot disagree about what wedged means.

test("isWedged agrees with checkHealth on the same threshold", () => {
  const now = 5_000_000;
  for (const poll of [1_000, 5_000, 30_000, 600_000]) {
    for (const age of [0, 1_000, 59_000, 61_000, 120_000, 3_600_000]) {
      const healthOk = checkHealth(
        { tickCompletedAtMs: now - age, pollIntervalMs: poll },
        now
      ).ok;
      const wedged = isWedged(now - age, poll, now);
      assert.equal(
        wedged,
        !healthOk,
        `poll=${poll} age=${age}: watchdog and health check disagree`
      );
    }
  }
});

test("isWedged tolerates a tick that overran, and fires once ticks stop", () => {
  const now = 1_000_000;
  assert.equal(isWedged(now - 30_000, 5_000, now), false, "30s late is alive");
  assert.equal(isWedged(now - 400_000, 5_000, now), true, "long past the floor");
});

// The regression this pins: the watchdog must never fire inside a confirmation
// wait the bidder itself is willing to make. A hardcoded 60s floor against a
// 120s receipt timeout would kill the process with a real transaction in
// flight — leaving its bid_actions row stuck at `submitted`.
test("the watchdog cannot fire inside a bid confirmation wait", () => {
  const now = 10_000_000;
  const receipt = config.receiptTimeoutMs;

  assert.ok(
    staleAfterMs(5_000, receipt) > receipt,
    `stale threshold ${staleAfterMs(5_000, receipt)}ms must exceed the ${receipt}ms receipt timeout`
  );

  // A bid blocking for the entire receipt timeout is still "alive".
  assert.equal(isWedged(now - receipt, 5_000, now, receipt), false);
  // ...with margin to spare on top.
  assert.equal(isWedged(now - Math.floor(receipt * 1.4), 5_000, now, receipt), false);

  // The floor tracks the receipt timeout rather than being pinned to a number.
  assert.equal(staleAfterMs(5_000, 300_000), 450_000);
  assert.equal(isWedged(now - 400_000, 5_000, now, 300_000), false);
});
