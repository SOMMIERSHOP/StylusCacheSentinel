import { parseEventLogs, type Log, type PublicClient } from "viem";
import { cacheManagerAbi } from "../abi";
import chalk from "chalk";

// shared log formatter for backfill + tail
export function logParsedEvents(
  logs: Log[],
  timestamps: Map<number, number>
): void {
  const parsed = parseEventLogs({ abi: cacheManagerAbi, logs });

  for (const event of parsed) {
    const blockNum = Number(event.blockNumber);
    const ts = timestamps.get(blockNum) ?? 0;
    const date = new Date(ts * 1000).toISOString();

    if (event.eventName === "InsertBid") {
      const args = event.args as {
        codehash: `0x${string}`;
        program: `0x${string}`;
        bid: bigint;
        size: bigint;
      };
      console.log(
        chalk.green(`  [InsertBid]`) +
          chalk.white(` block=${blockNum} ${date}`) +
          chalk.gray(
            `\n    program=${args.program}  bid=${args.bid} wei  size=${args.size} bytes` +
              `\n    codehash=${args.codehash}  tx=${event.transactionHash}`
          )
      );
    } else if (event.eventName === "DeleteBid") {
      const args = event.args as {
        codehash: `0x${string}`;
        bid: bigint;
        size: bigint;
      };
      console.log(
        chalk.red(`  [DeleteBid]`) +
          chalk.white(` block=${blockNum} ${date}`) +
          chalk.gray(
            `\n    bid=${args.bid} wei  size=${args.size} bytes` +
              `\n    codehash=${args.codehash}  tx=${event.transactionHash}`
          )
      );
    } else if (event.eventName === "SetCacheSize") {
      const args = event.args as { size: bigint };
      console.log(
        chalk.yellow(`  [SetCacheSize]`) +
          chalk.white(` block=${blockNum} ${date}`) +
          chalk.gray(`  size=${args.size}`)
      );
    } else if (event.eventName === "SetDecayRate") {
      const args = event.args as { decay: bigint };
      console.log(
        chalk.yellow(`  [SetDecayRate]`) +
          chalk.white(` block=${blockNum} ${date}`) +
          chalk.gray(`  decay=${args.decay}`)
      );
    } else if (event.eventName === "Pause") {
      console.log(
        chalk.red(`  [Pause]`) + chalk.white(` block=${blockNum} ${date}`)
      );
    } else if (event.eventName === "Unpause") {
      console.log(
        chalk.green(`  [Unpause]`) + chalk.white(` block=${blockNum} ${date}`)
      );
    }
  }
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
