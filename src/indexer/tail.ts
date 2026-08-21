/**
 * Live poller for new CacheManager events after backfill completes.
 *
 * Continuously polls the chain head, fetches any new logs since the last
 * processed block, parses and persists them, and prints them for
 * visibility. Designed to run indefinitely until aborted; individual
 * polling errors are logged and retried rather than crashing the process.
 *
 * @module
 */

import { type Log } from "viem";
import { getClient } from "../provider";
import { config } from "../config";
import { parseEvents, logParsedBatch, getBlockTimestamps } from "./format";
import { persistParsedEvents } from "../db/store";
import { writeHeartbeat } from "../sentinel/heartbeat";
import chalk from "chalk";

// poll for new events after backfill finishes, persist each tick and
// advance the checkpoint. Dedup'd via UNIQUE(tx_hash, log_index).
/**
 * Polls for new CacheManager events beyond `fromBlock` until `signal` is
 * aborted, persisting and logging each new batch as it arrives.
 *
 * Each tick fetches logs from `lastProcessed + 1` through the current
 * chain head, parses them, and persists them (advancing the checkpoint
 * even when a tick has no events). Runs forever until aborted; RPC errors
 * within a tick are caught, logged, and retried on the next poll interval
 * rather than propagated. Inserted rows are deduplicated on `(tx_hash,
 * log_index)`, matching `backfill`'s dedup guarantee.
 *
 * @param cacheManagerAddr - address of the CacheManager contract to poll
 * @param fromBlock - last block already processed (e.g. the return value of `backfill`); polling starts from `fromBlock + 1`
 * @param signal - abort signal; checked each loop iteration and during poll-interval sleeps to allow graceful shutdown
 */
export async function startTail(
  cacheManagerAddr: `0x${string}`,
  fromBlock: number,
  signal: AbortSignal
): Promise<void> {
  const client = getClient();
  let lastProcessed = fromBlock;

  console.log(chalk.cyan("  live tail running, waiting for new events...\n"));

  while (!signal.aborted) {
    try {
      const head = Number(await client.getBlockNumber());

      if (lastProcessed >= head) {
        await abortableSleep(config.pollIntervalMs, signal);
        continue;
      }

      const logs = await client.getLogs({
        address: cacheManagerAddr,
        fromBlock: BigInt(lastProcessed + 1),
        toBlock: BigInt(head),
      });

      if (logs.length > 0) {
        const blockNums = logs
          .filter((l) => l.blockNumber != null)
          .map((l) => Number(l.blockNumber));
        const timestamps = blockNums.length
          ? await getBlockTimestamps(blockNums, client)
          : new Map<number, number>();
        const parsed = parseEvents(logs as Log[], timestamps);
        persistParsedEvents(
          parsed.bids,
          parsed.evictions,
          parsed.configEvents,
          head
        );
        logParsedBatch(parsed);
      } else {
        persistParsedEvents([], [], [], head);
      }

      lastProcessed = head;
    } catch (err: any) {
      console.error(chalk.yellow(`  tail error: ${err.message}`));
    }

    // `sync` is a long-running loop too, so it reports liveness on the same
    // channel as the sentinel. Without this a `sync` container would sit
    // permanently unhealthy under the image's HEALTHCHECK.
    writeHeartbeat(config.pollIntervalMs);

    await abortableSleep(config.pollIntervalMs, signal);
  }
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
