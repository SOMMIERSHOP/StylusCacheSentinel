import { type Log } from "viem";
import { getClient } from "../provider";
import { config } from "../config";
import { parseEvents, getBlockTimestamps } from "./format";
import {
  persistParsedEvents,
  getLastSyncedBlock,
  recordSyncGap,
} from "../db/store";
import chalk from "chalk";

// batch-scan historical CacheManager events, persist per-batch and
// resume from sync_meta.last_block when re-run. Already-stored events
// are dedup'd via UNIQUE(tx_hash, log_index).
export async function backfill(
  cacheManagerAddr: `0x${string}`,
  fromBlock: number,
  toBlock: number,
  signal: AbortSignal
): Promise<number> {
  const client = getClient();
  const batchSize = config.batchSize;

  const lastSynced = getLastSyncedBlock();
  let cursor = fromBlock;
  if (lastSynced !== null && lastSynced + 1 > cursor) {
    cursor = lastSynced + 1;
    console.log(
      chalk.cyan(
        `  resuming from block ${cursor} (last synced: ${lastSynced})\n`
      )
    );
  }

  if (cursor > toBlock) {
    console.log(chalk.green("  already up to date, nothing to backfill\n"));
    return toBlock;
  }

  let totalEvents = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  const rangeStart = cursor;
  const range = toBlock - rangeStart;
  const skippedRanges: string[] = [];

  while (cursor <= toBlock) {
    if (signal.aborted) break;

    const end = Math.min(cursor + batchSize - 1, toBlock);

    let logs: Log[] = [];
    let retries = 0;
    const maxRetries = 4;
    let batchSkipped = false;

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
            chalk.red(
              `\n  backfill failed at block ${cursor} after ${maxRetries} retries, recording gap`
            )
          );
          skippedRanges.push(`${cursor}-${end}`);
          recordSyncGap(cursor, end, err?.message ?? "rpc error");
          batchSkipped = true;
          logs = [];
          break;
        }
        console.error(
          chalk.yellow(
            `\n  backfill error at block ${cursor} (attempt ${retries}/${maxRetries}): ${err.message}`
          )
        );
        await abortableSleep(3000, signal);
      }
    }
    if (signal.aborted) break;

    if (!batchSkipped) {
      if (logs.length > 0) {
        const blockNums = logs
          .filter((l) => l.blockNumber != null)
          .map((l) => Number(l.blockNumber));
        const timestamps = blockNums.length
          ? await getBlockTimestamps(blockNums, client)
          : new Map<number, number>();
        const parsed = parseEvents(logs, timestamps);
        const res = persistParsedEvents(
          parsed.bids,
          parsed.evictions,
          parsed.configEvents,
          end
        );
        totalEvents += logs.length;
        totalInserted +=
          res.bidsInserted + res.evictionsInserted + res.configInserted;
        totalSkipped +=
          res.bidsSkipped + res.evictionsSkipped + res.configSkipped;
      } else {
        // no events but still advance the checkpoint
        persistParsedEvents([], [], [], end);
      }
    }

    const pct =
      range > 0 ? (((end - rangeStart) / range) * 100).toFixed(1) : "100.0";

    process.stdout.write(
      chalk.gray(
        `\r  scan: block ${cursor}..${end} (${pct}%) — ${totalEvents} events, ` +
          `${totalInserted} new, ${totalSkipped} dedup'd`
      )
    );

    cursor = end + 1;
  }

  console.log();

  if (skippedRanges.length > 0) {
    console.log(
      chalk.red(
        `  warning: ${skippedRanges.length} batch(es) recorded as sync_gaps. ` +
          `Ranges: ${skippedRanges.join(", ")}`
      )
    );
  }

  return Math.min(cursor - 1, toBlock);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
