/**
 * Decodes raw CacheManager logs into typed, persistence-ready rows.
 *
 * Sits between the RPC layer (backfill/tail, which fetch raw logs) and the
 * DB layer (`db/store`, which persists them): this module is a pure,
 * side-effect-free translation step, plus a console pretty-printer used by
 * the live tail for human-readable output.
 *
 * @module
 */

import { parseEventLogs, type Log, type PublicClient } from "viem";
import { cacheManagerAbi } from "../abi";
import type {
  ParsedBid,
  ParsedEviction,
  ParsedConfigEvent,
} from "../db/store";
import chalk from "chalk";

/** Result of decoding a batch of raw logs, grouped by row type ready for `persistParsedEvents`. */
export interface ParsedBatch {
  bids: ParsedBid[];
  evictions: ParsedEviction[];
  configEvents: ParsedConfigEvent[];
}

// pure parser — produces row arrays ready for persistence
/**
 * Decodes a batch of raw CacheManager logs into typed rows grouped by
 * event kind (bids, evictions, config changes).
 *
 * Pure function: performs no I/O and has no side effects, so it can be
 * called for both historical backfill batches and live tail ticks. Logs
 * without a `transactionHash`/`logIndex` (i.e. not yet mined) are silently
 * skipped, as are event types outside the recognized CacheManager ABI
 * events.
 *
 * @param logs - raw logs fetched from the RPC provider for the CacheManager address
 * @param timestamps - block number -> unix timestamp lookup (see `getBlockTimestamps`); missing entries default to 0
 * @returns rows grouped into bids, evictions, and config events, ready for `persistParsedEvents`
 */
export function parseEvents(
  logs: Log[],
  timestamps: Map<number, number>
): ParsedBatch {
  const parsed = parseEventLogs({ abi: cacheManagerAbi, logs });
  const batch: ParsedBatch = { bids: [], evictions: [], configEvents: [] };

  for (const event of parsed) {
    const blockNumber = Number(event.blockNumber);
    const timestamp = timestamps.get(blockNumber) ?? 0;
    const txHash = event.transactionHash as `0x${string}` | null;
    const logIndex = event.logIndex;

    // mined logs always have these; skip pending logs defensively
    if (txHash == null || logIndex == null) continue;

    if (event.eventName === "InsertBid") {
      const args = event.args as {
        codehash: `0x${string}`;
        program: `0x${string}`;
        bid: bigint;
        size: bigint;
      };
      batch.bids.push({
        codehash: args.codehash,
        program: args.program,
        bidWei: args.bid.toString(),
        size: Number(args.size),
        blockNumber,
        txHash,
        logIndex,
        timestamp,
      });
    } else if (event.eventName === "DeleteBid") {
      const args = event.args as {
        codehash: `0x${string}`;
        bid: bigint;
        size: bigint;
      };
      batch.evictions.push({
        codehash: args.codehash,
        bidWei: args.bid.toString(),
        size: Number(args.size),
        blockNumber,
        txHash,
        logIndex,
        timestamp,
      });
    } else if (event.eventName === "SetCacheSize") {
      const args = event.args as { size: bigint };
      batch.configEvents.push({
        eventType: "SetCacheSize",
        value: args.size.toString(),
        blockNumber,
        txHash,
        logIndex,
        timestamp,
      });
    } else if (event.eventName === "SetDecayRate") {
      const args = event.args as { decay: bigint };
      batch.configEvents.push({
        eventType: "SetDecayRate",
        value: args.decay.toString(),
        blockNumber,
        txHash,
        logIndex,
        timestamp,
      });
    } else if (event.eventName === "Pause") {
      batch.configEvents.push({
        eventType: "Pause",
        value: null,
        blockNumber,
        txHash,
        logIndex,
        timestamp,
      });
    } else if (event.eventName === "Unpause") {
      batch.configEvents.push({
        eventType: "Unpause",
        value: null,
        blockNumber,
        txHash,
        logIndex,
        timestamp,
      });
    }
  }

  return batch;
}

// pretty-print a parsed batch (used by the live tail for visibility)
/**
 * Pretty-prints a parsed batch to the console in block order, color-coded
 * by event kind. Used by the live tail to give operators real-time
 * visibility into indexed activity; has no effect on persisted state.
 *
 * @param batch - decoded events to render, as produced by `parseEvents`
 */
export function logParsedBatch(batch: ParsedBatch): void {
  const all: { block: number; render: () => void }[] = [];

  for (const b of batch.bids) {
    all.push({
      block: b.blockNumber,
      render: () => {
        const date = new Date(b.timestamp * 1000).toISOString();
        console.log(
          chalk.green(`  [InsertBid]`) +
            chalk.white(` block=${b.blockNumber} ${date}`) +
            chalk.gray(
              `\n    program=${b.program}  bid=${b.bidWei} wei  size=${b.size} bytes` +
                `\n    codehash=${b.codehash}  tx=${b.txHash}`
            )
        );
      },
    });
  }

  for (const e of batch.evictions) {
    all.push({
      block: e.blockNumber,
      render: () => {
        const date = new Date(e.timestamp * 1000).toISOString();
        console.log(
          chalk.red(`  [DeleteBid]`) +
            chalk.white(` block=${e.blockNumber} ${date}`) +
            chalk.gray(
              `\n    bid=${e.bidWei} wei  size=${e.size} bytes` +
                `\n    codehash=${e.codehash}  tx=${e.txHash}`
            )
        );
      },
    });
  }

  for (const c of batch.configEvents) {
    all.push({
      block: c.blockNumber,
      render: () => {
        const date = new Date(c.timestamp * 1000).toISOString();
        const label =
          c.eventType === "Pause"
            ? chalk.red(`  [Pause]`)
            : c.eventType === "Unpause"
              ? chalk.green(`  [Unpause]`)
              : chalk.yellow(`  [${c.eventType}]`);
        console.log(
          label +
            chalk.white(` block=${c.blockNumber} ${date}`) +
            (c.value !== null ? chalk.gray(`  value=${c.value}`) : "")
        );
      },
    });
  }

  all.sort((a, b) => a.block - b.block);
  for (const entry of all) entry.render();
}

// bulk-fetch timestamps, dedupes block numbers first
/**
 * Fetches unix timestamps for a set of block numbers, deduplicating first
 * and fetching in small chunks to avoid overwhelming the RPC provider.
 *
 * @param blockNumbers - block numbers to look up (may contain duplicates, e.g. one per log in a batch)
 * @param client - viem public client used to fetch blocks
 * @returns map of block number to unix timestamp (seconds), covering every unique input block
 */
export async function getBlockTimestamps(
  blockNumbers: number[],
  client: PublicClient
): Promise<Map<number, number>> {
  const unique = [...new Set(blockNumbers)];
  const map = new Map<number, number>();

  const chunkSize = 20;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const blocks = await Promise.all(
      chunk.map((n) => client.getBlock({ blockNumber: BigInt(n) }))
    );
    for (const block of blocks) {
      map.set(Number(block.number), Number(block.timestamp));
    }
  }

  return map;
}
