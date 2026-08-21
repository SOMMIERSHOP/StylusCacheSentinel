/**
 * Historical batch-scanner for CacheManager events.
 *
 * Walks a block range in fixed-size batches, fetching logs via RPC, parsing
 * them, and persisting each batch immediately so progress survives a crash
 * or restart. Resumes from `sync_meta.last_block` when re-run over an
 * overlapping range, and records unrecoverable RPC failures as sync gaps
 * rather than aborting the whole run.
 *
 * @module
 */

import { type Log } from "viem";
import { getClient } from "../provider";
import { config } from "../config";
import { parseEvents, getBlockTimestamps } from "./format";
import {
  persistParsedEvents,
  getLastSyncedBlock,
  recordSyncGap,
} from "../db/store";
import { writeHeartbeat } from "../sentinel/heartbeat";
import chalk from "chalk";

// Nominal interval stamped while backfilling. A genesis-to-head scan can spend
// well over the tail's 4s poll on a single batch (2000 blocks of getLogs plus
// timestamp fetches), so liveness is judged on a minutes-scale budget here.
// Using the tail's interval instead would flag a merely slow batch as wedged.
const BACKFILL_HEARTBEAT_INTERVAL_MS = 60_000;

// batch-scan historical CacheManager events, persist per-batch and
// resume from sync_meta.last_block when re-run. Already-stored events
// are dedup'd via UNIQUE(tx_hash, log_index).
/**
 * Scans `[fromBlock, toBlock]` for CacheManager events in batches of
 * `config.batchSize`, persisting each batch as it completes.
 *
 * If a previously synced block (`sync_meta.last_block`) is ahead of
 * `fromBlock`, the scan resumes from there instead of re-scanning already
 * -processed blocks. Inserted rows are deduplicated on `(tx_hash,
 * log_index)`, so overlapping ranges are safe to re-run. A batch that
 * fails after `maxRetries` RPC attempts is recorded via `recordSyncGap`
 * (not thrown) so the scan can continue past transient provider outages;
 * callers should check for gaps afterward (e.g. via `reconcile`).
 *
 * @param cacheManagerAddr - address of the CacheManager contract to scan
 * @param fromBlock - lower bound of the scan range (inclusive); may be
 *   overridden by a later resume point found in `sync_meta`
 * @param toBlock - upper bound of the scan range (inclusive)
 * @param signal - abort signal; checked between batches and during retry
 *   backoff to allow graceful early termination
 * @returns the last block number actually processed (may be less than
 *   `toBlock` if aborted)
 */
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

    // Progress on a long scan is still liveness — see the constant above.
    writeHeartbeat(BACKFILL_HEARTBEAT_INTERVAL_MS);

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
