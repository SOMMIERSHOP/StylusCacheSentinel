import { parseEventLogs, type Log, type PublicClient } from "viem";
import { cacheManagerAbi } from "../abi";
import type {
  ParsedBid,
  ParsedEviction,
  ParsedConfigEvent,
} from "../db/store";
import chalk from "chalk";

export interface ParsedBatch {
  bids: ParsedBid[];
  evictions: ParsedEviction[];
  configEvents: ParsedConfigEvent[];
}

// pure parser — produces row arrays ready for persistence
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
