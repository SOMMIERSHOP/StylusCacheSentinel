/**
 * Submits (or simulates) CacheManager bids for assessments that need one,
 * applying a strict, ordered stack of fail-safes before any value leaves the
 * wallet.
 *
 * Order: monitor-only (no program address) → per-bid ceiling → per-window
 * spend cap → dry-run → live submit + receipt confirmation. Every outcome,
 * including blocked and dry-run ones, is recorded via the bid-action store
 * for audit/history.
 *
 * @module
 */
import { formatEther } from "viem";
import chalk from "chalk";
import { getClient, resolveChain } from "../provider";
import { getWalletClient, getAccount } from "../wallet";
import { cacheManagerWriteAbi } from "../abi";
import {
  recordBidAction,
  updateBidAction,
  getSpendWeiSince,
} from "../db/store";
import type { Assessment } from "./assess";

/** Policy limits and runtime mode enforced by {@link executeBid} for every bid. */
export interface BidLimits {
  cacheManager: `0x${string}`;
  maxSpendPerWindowWei: bigint;
  spendWindowSeconds: number;
  dryRun: boolean; // when true, no transaction is ever sent — see fail-safe 3 below
  receiptTimeoutMs: number; // how long to wait for confirmation before returning "submitted"
}

/** Result classification for a bid attempt, used for log coloring and audit records. */
export type BidOutcome =
  | "dry-run"
  | "blocked"
  | "submitted"
  | "confirmed"
  | "failed";

/** Outcome of one {@link executeBid} call: classification, optional tx hash, and a human-readable note for logging. */
export interface BidResult {
  outcome: BidOutcome;
  txHash?: `0x${string}`;
  note: string;
}

// Execute (or simulate) a single bid for an assessment that needs one,
// applying all fail-safes in order: per-bid ceiling, per-window spend cap,
// dry-run, then live submission with receipt confirmation.
/**
 * Executes (or simulates) a single bid for an assessment whose decision says
 * it needs one. Applies fail-safes in order — monitor-only (no resolvable
 * program address), per-bid ceiling, per-window spend cap, dry-run — before
 * ever touching the chain; only then does it submit `placeBid` live and wait
 * for a receipt. Every outcome (including blocked/dry-run) is persisted via
 * `recordBidAction`/`updateBidAction`.
 *
 * @param a - The assessment with a bid decision to act on.
 * @param limits - Effective spend/ceiling/mode limits for this bid.
 * @returns The bid outcome, optional tx hash, and a human-readable note.
 */
export async function executeBid(
  a: Assessment,
  limits: BidLimits
): Promise<BidResult> {
  const { codehash, program } = a.target;
  const bidWei = a.decision.recommendedBidWei;
  const bidEth = formatEther(bidWei);

  // Fail-safe 0: placeBid is keyed on the program ADDRESS. A target we only
  // know by codehash (no program recoverable from the indexer or chain) is
  // monitor-only — we can observe its cache status but cannot bid for it.
  if (!program) {
    const note =
      "monitor-only: no program address known for this codehash — cannot place an address-keyed bid";
    recordBidAction({
      codehash,
      program: null,
      bidWei: bidWei.toString(),
      status: "blocked",
      txHash: null,
      reason: note,
    });
    return { outcome: "blocked", note };
  }

  // Fail-safe 1: per-bid ceiling.
  if (a.decision.blocked) {
    const note = `bid ${bidEth} ETH exceeds per-bid cap — skipping (manual attention needed)`;
    recordBidAction({
      codehash,
      program,
      bidWei: bidWei.toString(),
      status: "blocked",
      txHash: null,
      reason: note,
    });
    return { outcome: "blocked", note };
  }

  // Fail-safe 2: per-window spend cap. In dry-run we also count prior dry-run
  // rows so a simulation surfaces when live mode would hit the cap.
  const windowStart = Math.floor(Date.now() / 1000) - limits.spendWindowSeconds;
  const spent = getSpendWeiSince(windowStart, { includeDryRun: limits.dryRun });
  if (spent + bidWei > limits.maxSpendPerWindowWei) {
    const prefix = limits.dryRun ? "[dry-run] " : "";
    const note =
      `${prefix}spend cap reached: ${formatEther(spent)} + ${bidEth} ` +
      `> ${formatEther(limits.maxSpendPerWindowWei)} ETH/window — skipping`;
    recordBidAction({
      codehash,
      program,
      bidWei: bidWei.toString(),
      status: "blocked",
      txHash: null,
      reason: note,
    });
    return { outcome: "blocked", note };
  }

  // Fail-safe 3: dry-run never touches the chain.
  if (limits.dryRun) {
    const note = `[dry-run] would bid ${bidEth} ETH — ${a.decision.reason}`;
    recordBidAction({
      codehash,
      program,
      bidWei: bidWei.toString(),
      status: "dry-run",
      txHash: null,
      reason: a.decision.reason,
    });
    return { outcome: "dry-run", note };
  }

  // Live submission.
  const wallet = await getWalletClient();
  const account = getAccount();
  const chain = await resolveChain();
  let txHash: `0x${string}`;
  try {
    txHash = await wallet.writeContract({
      account,
      chain,
      address: limits.cacheManager,
      abi: cacheManagerWriteAbi,
      functionName: "placeBid",
      args: [program],
      value: bidWei,
    });
  } catch (err: any) {
    const note = `submission failed: ${err?.shortMessage ?? err?.message ?? "unknown error"}`;
    recordBidAction({
      codehash,
      program,
      bidWei: bidWei.toString(),
      status: "failed",
      txHash: null,
      reason: note,
    });
    return { outcome: "failed", note };
  }

  const actionId = recordBidAction({
    codehash,
    program,
    bidWei: bidWei.toString(),
    status: "submitted",
    txHash,
    reason: a.decision.reason,
  });

  // Confirmation — bounds the detection→confirmation latency we report.
  try {
    const receipt = await getClient().waitForTransactionReceipt({
      hash: txHash,
      timeout: limits.receiptTimeoutMs,
    });
    if (receipt.status === "success") {
      updateBidAction(actionId, {
        status: "confirmed",
        confirmedAt: Math.floor(Date.now() / 1000),
      });
      return {
        outcome: "confirmed",
        txHash,
        note: `bid ${bidEth} ETH confirmed in block ${receipt.blockNumber}`,
      };
    }
    updateBidAction(actionId, { status: "failed" });
    return { outcome: "failed", txHash, note: `tx ${txHash} reverted` };
  } catch (err: any) {
    // Submitted but not yet confirmed within the timeout — leave as submitted.
    return {
      outcome: "submitted",
      txHash,
      note: `bid ${bidEth} ETH submitted (tx ${txHash}); receipt pending: ${err?.message ?? ""}`,
    };
  }
}

/**
 * Maps a bid outcome to the chalk color function used to render its log line.
 *
 * @param outcome - The bid outcome to color.
 * @returns A chalk styling function to wrap the log message with.
 */
export function colorForOutcome(outcome: BidOutcome): (s: string) => string {
  switch (outcome) {
    case "confirmed":
      return chalk.green;
    case "submitted":
    case "dry-run":
      return chalk.cyan;
    case "blocked":
      return chalk.yellow;
    case "failed":
      return chalk.red;
  }
}
