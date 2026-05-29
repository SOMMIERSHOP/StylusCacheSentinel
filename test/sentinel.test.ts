import { test } from "node:test";
import assert from "node:assert/strict";

import { recommendedBid, computeBidDecision } from "../src/sentinel/assess";

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
