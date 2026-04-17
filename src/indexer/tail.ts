import { type Log } from "viem";
import { getClient } from "../provider";
import { config } from "../config";
import { parseEvents, logParsedBatch, getBlockTimestamps } from "./format";
import { persistParsedEvents } from "../db/store";
import chalk from "chalk";

// poll for new events after backfill finishes, persist each tick and
// advance the checkpoint. Dedup'd via UNIQUE(tx_hash, log_index).
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
