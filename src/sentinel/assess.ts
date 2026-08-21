/**
 * Reads on-chain CacheManager/ArbWasmCache state per watch target and decides
 * whether — and how much — the sentinel should bid to keep it cached.
 *
 * CacheManager stores bids in a decay-inflated space (stored = msg.value +
 * block.timestamp * decay); this module normalizes stored-space reads back to
 * msg.value space before comparing against the plain-msg.value eviction floor
 * returned by getMinBid. The decision logic itself ({@link computeBidDecision})
 * is a pure function, kept free of chain/DB access so it can be unit-tested.
 *
 * @module
 */
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
/** A single CacheManager queue entry, in stored (decay-inflated) space — see the module note above. */
export interface CacheEntry {
  bidStoredWei: bigint; // decay-inflated; not directly comparable to getMinBid's msg.value-space result
  sizeBytes: bigint;
}

/** Snapshot of on-chain CacheManager state fetched once per tick and shared across all target assessments in that tick. */
export interface TickContext {
  cacheManager: `0x${string}`;
  freeBytes: bigint;
  // block.timestamp * decay; converts stored-space bids (CacheEntry.bidStoredWei) to msg.value space.
  decayOffsetWei: bigint;
  // codehash(lowercase) -> current cache entry (stored-space bid + size).
  entries: Map<string, CacheEntry>;
}

/** Inputs to the pure decision function {@link computeBidDecision}, already normalized to msg.value space. */
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

/** Output of {@link computeBidDecision}: whether to bid, how much, and why. */
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
/**
 * Applies the headroom margin to an on-chain minimum bid, in basis points so
 * fractional percentages (e.g. 12.5%) survive BigInt math. Result is in
 * msg.value space (same as `minBidWei`).
 *
 * @param minBidWei - Eviction floor / minimum bid, in msg.value space (as returned by getMinBid).
 * @param headroomPercent - Desired margin above the floor, as a percent (e.g. 12.5 for 12.5%).
 * @returns The recommended bid in msg.value space; 0n when minBidWei is 0n (free space).
 */
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
/**
 * Decides whether a target needs a bid this tick and, if so, how much — the
 * pure, unit-tested heart of Milestone 4. Takes no chain or DB dependency: all
 * state is passed in via {@link BidDecisionInput}, already normalized to
 * msg.value space.
 *
 * @param input - Normalized on-chain state plus policy (headroom, ceiling) for one target.
 * @returns The bid decision: whether to bid, the recommended amount, a
 * human-readable reason, and whether the recommended amount is blocked by the
 * per-bid ceiling.
 */
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

/** Result of assessing one watch target for a tick: on-chain state plus the resulting bid decision, or a read error. */
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
/**
 * Extracts the CacheManager custom-error name (e.g. "ProgramExpired",
 * "BidTooSmall") out of a viem contract revert, if the error was decoded.
 *
 * @param err - The error thrown by a viem readContract/writeContract call.
 * @returns The decoded error name, or null if err isn't a recognized contract revert.
 */
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
const ACTIVATION_ERRORS = new Set([
  "ProgramExpired",
  "ProgramNotActivated",
  // Program activated under an older Stylus version; re-activation is the fix.
  "ProgramNeedsUpgrade",
]);

/**
 * Whether a decoded revert name means the target needs Stylus re-activation
 * before it can be cached at all — a condition no amount of bidding resolves.
 *
 * @param name - decoded revert name, e.g. from {@link revertErrorName}
 * @returns true if the target is blocked on re-activation rather than on price
 */
export function isActivationError(name: string | null): boolean {
  return name !== null && ACTIVATION_ERRORS.has(name);
}

/**
 * Extract the raw 4-byte selector from a revert viem could not decode against
 * the ABI, so an unrecognized error can still be reported compactly instead of
 * as a multi-line stack dump.
 *
 * @param err - the error thrown by a viem contract call
 * @returns the `0x`-prefixed selector, or null if the revert decoded normally
 *   or was not a contract revert at all
 */
export function revertSelector(err: unknown): string | null {
  if (err instanceof BaseError) {
    const revert = err.walk(
      (e) => e instanceof ContractFunctionRevertedError
    ) as ContractFunctionRevertedError | null;
    if (revert && !revert.data?.errorName && revert.signature) {
      return revert.signature;
    }
  }
  return null;
}

// Read live state for one target and run the decision. `maxBidEth`/`headroom`
// are the effective (per-target-overridden) policy values.
/**
 * Reads live CacheManager/ArbWasmCache state for one target and runs it
 * through {@link computeBidDecision}. Fail-safe: `codehashIsCached`/`getMinBid`
 * read failures (including ProgramExpired/ProgramNotActivated reverts, which
 * need re-activation rather than a bid) are caught and returned as a
 * no-action Assessment with `error` or `reason` set, rather than throwing and
 * aborting the tick.
 *
 * @param ctx - Shared per-tick on-chain snapshot (see {@link TickContext}).
 * @param target - The resolved program/codehash target to assess.
 * @param label - Human-readable label for logging.
 * @param maxBidEth - Effective (possibly per-target-overridden) bid ceiling, in ETH.
 * @param headroomPercent - Effective (possibly per-target-overridden) headroom target, in percent.
 * @returns The assessment: cache status, minimum bid, our standing bid, and the bid decision.
 */
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
    if (isActivationError(name)) {
      // Can't bid our way out of this — needs Stylus re-activation.
      return noActionAssessment(target, label, cached, ourValueWei, {
        reason: `${name} — program needs re-activation before it can be cached`,
      });
    }
    if (name) {
      return noActionAssessment(target, label, cached, ourValueWei, {
        error: `getMinBid reverted: ${name}`,
      });
    }
    // Undecodable revert: report the selector rather than viem's multi-line
    // dump, so one unknown error can't drown a multi-target tick's log.
    const selector = revertSelector(err);
    return noActionAssessment(target, label, cached, ourValueWei, {
      error: selector
        ? `getMinBid reverted with unrecognized error ${selector} (not in the CacheManager ABI)`
        : err?.message ?? "getMinBid read failed",
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
