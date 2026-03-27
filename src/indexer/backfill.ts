import { type Log } from "viem";
import { getClient } from "../provider";
import { config } from "../config";
import { logParsedEvents, getBlockTimestamps } from "./format";
import chalk from "chalk";

// batch-scan historical CacheManager events
export async function backfill(
  cacheManagerAddr: `0x${string}`,
  fromBlock: number,
  toBlock: number,
  signal: AbortSignal
): Promise<number> {
  const client = getClient();
  const batchSize = config.batchSize;
  let cursor = fromBlock;
  let totalEvents = 0;
  const range = toBlock - fromBlock;
  const skippedRanges: string[] = [];

  while (cursor <= toBlock) {
    if (signal.aborted) break;

    const end = Math.min(cursor + batchSize - 1, toBlock);

    let logs: Log[] = [];
    let retries = 0;
    const maxRetries = 4;
    while (true) {
      if (signal.aborted) break;
      try {
        logs = await client.getLogs({
          address: cacheManagerAddr,
          fromBlock: BigInt(cursor),
          toBlock: BigInt(end),
        });
        break;
      } catch (err: any) {
        retries++;
        if (retries > maxRetries) {
          console.error(
            chalk.red(`\n  backfill failed at block ${cursor} after ${maxRetries} retries, skipping batch`)
          );
          skippedRanges.push(`${cursor}-${end}`);
          logs = [];
          break;
        }
        console.error(
          chalk.yellow(`\n  backfill error at block ${cursor} (attempt ${retries}/${maxRetries}): ${err.message}`)
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 3000);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          }
          signal.addEventListener("abort", done, { once: true });
        });
      }
    }
    if (signal.aborted) break;

    if (logs.length > 0) {
      const blockNums = logs
        .filter((l) => l.blockNumber != null)
        .map((l) => Number(l.blockNumber));

      if (blockNums.length > 0) {
        const timestamps = await getBlockTimestamps(blockNums, client);
        logParsedEvents(logs, timestamps);
      }
      totalEvents += logs.length;
    }

    const pct = range > 0
      ? (((end - fromBlock) / range) * 100).toFixed(1)
      : "100.0";

    process.stdout.write(
      chalk.gray(
        `\r  scan: block ${cursor}..${end} (${pct}%) — ${totalEvents} events so far`
      )
    );

    cursor = end + 1;
  }

  console.log();

  if (skippedRanges.length > 0) {
    console.log(
      chalk.red(
        `  warning: ${skippedRanges.length} batch(es) skipped due to RPC errors. ` +
          `Missing blocks: ${skippedRanges.join(", ")}`
      )
    );
  }

  return Math.min(cursor - 1, toBlock);
}
