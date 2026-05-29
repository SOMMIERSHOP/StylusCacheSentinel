import { formatEther } from "viem";
import { arbitrum } from "viem/chains";
import chalk from "chalk";
import { getClient } from "../provider";
import { getWalletClient, getAccount } from "../wallet";
import { cacheManagerWriteAbi } from "../abi";
import {
  recordBidAction,
  updateBidAction,
  getSpendWeiSince,
} from "../db/store";
import type { Assessment } from "./assess";

export interface BidLimits {
  cacheManager: `0x${string}`;
  maxSpendPerWindowWei: bigint;
  spendWindowSeconds: number;
  dryRun: boolean;
  receiptTimeoutMs: number;
}

export type BidOutcome =
  | "dry-run"
  | "blocked"
  | "submitted"
  | "confirmed"
  | "failed";

export interface BidResult {
  outcome: BidOutcome;
  txHash?: `0x${string}`;
  note: string;
}

// Execute (or simulate) a single bid for an assessment that needs one,
// applying all fail-safes in order: per-bid ceiling, per-window spend cap,
// dry-run, then live submission with receipt confirmation.
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
  const wallet = getWalletClient();
  const account = getAccount();
  let txHash: `0x${string}`;
  try {
    txHash = await wallet.writeContract({
      account,
      chain: arbitrum,
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
