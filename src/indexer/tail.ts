import { type Log } from "viem";
import { getClient } from "../provider";
import { config } from "../config";
import { logParsedEvents, getBlockTimestamps } from "./format";
import chalk from "chalk";

// poll for new events after backfill finishes
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

        if (blockNums.length > 0) {
          const timestamps = await getBlockTimestamps(blockNums, client);
          logParsedEvents(logs as Log[], timestamps);
        }
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
