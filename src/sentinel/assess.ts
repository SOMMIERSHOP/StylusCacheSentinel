import { parseEther, BaseError, ContractFunctionRevertedError } from "viem";
import { getClient } from "../provider";
import { config } from "../config";
import { arbWasmCacheAbi, cacheManagerWriteAbi } from "../abi";
import type { ResolvedTarget } from "../codehash";

// On-chain snapshot reused across all targets within one tick.
//
// Unit note: CacheManager stores bids in a *decay-inflated* space —
// stored = msg.value + block.timestamp * decay (see _toBid). getEntries()
// returns that stored value. getMinBid(), by contrast, returns a plain
// msg.value (it subtracts block.timestamp * decay back out). To compare our
// standing bid against the eviction floor we must work in ONE space, so we
// carry `decayOffsetWei = block.timestamp * decay` and convert stored bids
// back to msg.value space before comparing.
export interface CacheEntry {
  bidStoredWei: bigint;
  sizeBytes: bigint;
}

export interface TickContext {
  cacheManager: `0x${string}`;
  freeBytes: bigint;
  decayOffsetWei: bigint;
  // codehash(lowercase) -> current cache entry (stored-space bid + size).
  entries: Map<string, CacheEntry>;
}

export interface BidDecisionInput {
  cached: boolean;
  // Eviction floor, in msg.value space (what getMinBid returns).
  minBidWei: bigint;
  // Our standing bid converted to msg.value space, or null if not in the queue.
  ourValueWei: bigint | null;
  // Free cache bytes (cacheSize - queueSize) and our entry size, if known.
  freeBytes: bigint;
  sizeBytes: bigint | null;
  headroomPercent: number;
  maxBidWei: bigint;
}

export interface BidDecision {
  needsBid: boolean;
  recommendedBidWei: bigint;
  reason: string;
  // recommended bid exceeds the configured per-bid ceiling.
  blocked: boolean;
}

// Apply the headroom margin to the on-chain minimum bid. Uses basis points so
// fractional percentages (e.g. 12.5%) don't lose precision in BigInt math.
// Result is in msg.value space (same as minBidWei).
//
// Multi-eviction note (verified against CacheManager source): getMinBid returns
// the LARGEST stored bid among the entries that must be evicted to free space
// for our size (not the sum), minus the decay offset. _makeSpace evicts those
// entries one-by-one, each requiring bid >= that threshold. So a single bid of
// minBidWei already clears the whole eviction set; minBidWei*(1+headroom) only
// adds margin. The residual risk is purely the read→land race: a competitor
// raising the threshold slot by more than the headroom makes placeBid revert
// BidTooSmall, which is handled as a 'failed' outcome and retried next tick —
// never an overpay. (Headroom is relative, so when the floor is tiny the
// absolute buffer is tiny too; the safe BidTooSmall-retry path covers that.)
export function recommendedBid(minBidWei: bigint, headroomPercent: number): bigint {
  if (minBidWei === 0n) return 0n;
  const bps = BigInt(Math.round(headroomPercent * 100));
  return minBidWei + (minBidWei * bps) / 10_000n;
}

function hasFreeRoom(freeBytes: bigint, sizeBytes: bigint | null): boolean {
  return sizeBytes !== null ? freeBytes >= sizeBytes : freeBytes > 0n;
}

// Pure bidding decision — the heart of M4, kept free of chain/DB so it can be
// exhaustively unit-tested. All wei inputs are in msg.value space. Encodes:
// bid when not cached; do nothing while the cache has room for our size (no
// eviction pressure); when contended, rebid once our standing bid's margin
// over the eviction floor falls below the headroom target.
export function computeBidDecision(input: BidDecisionInput): BidDecision {
  // Never emit a literal 0-value bid: recommendedBid() is only 0 when the floor
  // is 0 (free space, or a decayed-to-zero eviction floor). Floor to 1 wei so
  // placeBid still re-baselines us and can't trip BidTooSmall if the floor has
  // crept above 0 between this read and the tx landing. Cost is negligible.
  const raw = recommendedBid(input.minBidWei, input.headroomPercent);
  const recommended = raw === 0n ? 1n : raw;
  const blocked = recommended > input.maxBidWei;

  if (!input.cached) {
    const note = raw === 0n ? " (free space — minimal 1 wei insert)" : "";
    return {
      needsBid: true,
      recommendedBidWei: recommended,
      reason: `not cached — placing bid to (re)insert${note}`,
      blocked,
    };
  }

  // Cached with room for our size: nothing can force an eviction, so idle.
  if (hasFreeRoom(input.freeBytes, input.sizeBytes)) {
    return {
      needsBid: false,
      recommendedBidWei: recommended,
      reason: "cached; cache has free space for this size",
      blocked: false,
    };
  }

  // Cached and contended. Without our standing bid value we can't measure the
  // margin; stay conservative and do nothing rather than risk an over-bid.
  if (input.ourValueWei === null) {
    return {
      needsBid: false,
      recommendedBidWei: recommended,
      reason: "cached; contended but standing bid unknown — holding",
      blocked: false,
    };
  }

  const margin = input.ourValueWei - input.minBidWei;
  const targetMargin =
    (input.minBidWei * BigInt(Math.round(input.headroomPercent * 100))) /
    10_000n;
  if (margin < targetMargin) {
    return {
      needsBid: true,
      recommendedBidWei: recommended,
      reason: `margin ${margin} wei below target ${targetMargin} wei — rebidding`,
      blocked,
    };
  }

  return {
    needsBid: false,
    recommendedBidWei: recommended,
    reason: "cached with sufficient headroom",
    blocked: false,
  };
}

export interface Assessment {
  target: ResolvedTarget;
  label: string;
  cached: boolean;
  minBidWei: bigint;
  ourValueWei: bigint | null;
  decision: BidDecision;
  error?: string;
}

// Pull the CacheManager custom-error name out of a viem revert, if present.
export function revertErrorName(err: unknown): string | null {
  if (err instanceof BaseError) {
    const revert = err.walk(
      (e) => e instanceof ContractFunctionRevertedError
    ) as ContractFunctionRevertedError | null;
    if (revert?.data?.errorName) return revert.data.errorName;
  }
  return null;
}

// Errors that mean "this program can't be cache-bid right now and the sentinel
// can't fix it by bidding" — the Stylus activation must be renewed first.
const ACTIVATION_ERRORS = new Set(["ProgramExpired", "ProgramNotActivated"]);

// Read live state for one target and run the decision. `maxBidEth`/`headroom`
// are the effective (per-target-overridden) policy values.
export async function assessTarget(
  ctx: TickContext,
  target: ResolvedTarget,
  label: string,
  maxBidEth: string,
  headroomPercent: number
): Promise<Assessment> {
  const client = getClient();
  const maxBidWei = parseEther(maxBidEth as `${number}`);
  const entry = ctx.entries.get(target.codehash.toLowerCase()) ?? null;
  // Convert our stored-space bid to msg.value space for an apples-to-apples
  // comparison against getMinBid. This is a *comparison-only* quantity: it can
  // legitimately go negative (our bid has decayed below the current baseline)
  // and is never sent on-chain — the value we submit is always recommendedBid().
  const ourValueWei = entry ? entry.bidStoredWei - ctx.decayOffsetWei : null;
  const sizeBytes = entry ? entry.sizeBytes : null;

  // cached flag first — cheap, and we want it even if getMinBid reverts.
  let cached: boolean;
  try {
    cached = (await client.readContract({
      address: config.arbWasmCacheAddress,
      abi: arbWasmCacheAbi,
      functionName: "codehashIsCached",
      args: [target.codehash],
    })) as boolean;
  } catch (err: any) {
    return noActionAssessment(target, label, false, ourValueWei, {
      error: err?.message ?? "codehashIsCached read failed",
    });
  }

  let minBidWei: bigint;
  try {
    minBidWei = (await client.readContract({
      address: ctx.cacheManager,
      abi: cacheManagerWriteAbi,
      functionName: "getMinBid",
      args: [target.codehash],
    })) as bigint;
  } catch (err: any) {
    const name = revertErrorName(err);
    if (name && ACTIVATION_ERRORS.has(name)) {
      // Can't bid our way out of this — needs Stylus re-activation.
      return noActionAssessment(target, label, cached, ourValueWei, {
        reason: `${name} — program needs re-activation before it can be cached`,
      });
    }
    return noActionAssessment(target, label, cached, ourValueWei, {
      error: name ? `getMinBid reverted: ${name}` : err?.message ?? "getMinBid read failed",
    });
  }

  const decision = computeBidDecision({
    cached,
    minBidWei,
    ourValueWei,
    freeBytes: ctx.freeBytes,
    sizeBytes,
    headroomPercent,
    maxBidWei,
  });

  return { target, label, cached, minBidWei, ourValueWei, decision };
}

function noActionAssessment(
  target: ResolvedTarget,
  label: string,
  cached: boolean,
  ourValueWei: bigint | null,
  opts: { reason?: string; error?: string }
): Assessment {
  return {
    target,
    label,
    cached,
    minBidWei: 0n,
    ourValueWei,
    decision: {
      needsBid: false,
      recommendedBidWei: 0n,
      reason: opts.reason ?? "skipped",
      blocked: false,
    },
    error: opts.error,
  };
}
