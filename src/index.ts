import chalk from "chalk";
import { resolveCacheManager } from "./resolver";
import { readCacheState } from "./indexer/state";
import { backfill } from "./indexer/backfill";
import { startTail } from "./indexer/tail";
import { reconcile, printReconcileReport } from "./indexer/reconcile";
import { getClient } from "./provider";

// Stylus went live on Arbitrum One around Sep 3 2024.
// CacheManager was deployed as part of that same upgrade batch.
const STYLUS_GENESIS_BLOCK = 245_000_000;

async function cmdSync() {
  console.log(chalk.cyan("\n  Stylus Cache Sentinel — sync\n"));

  const ac = new AbortController();
  process.on("SIGINT", () => {
    console.log(chalk.yellow("\n  shutting down..."));
    ac.abort();
  });
  process.on("SIGTERM", () => ac.abort());

  const cacheManager = await resolveCacheManager();
  console.log(chalk.white(`  CacheManager: ${cacheManager}\n`));

  const state = await readCacheState(cacheManager);
  const usedKb = (Number(state.queueSize) / 1024).toFixed(1);
  const totalKb = (Number(state.cacheSize) / 1024).toFixed(1);
  console.log(chalk.white(`  cache usage: ${usedKb} KB / ${totalKb} KB`));
  console.log(chalk.white(`  decay: ${state.decay}  paused: ${state.isPaused}\n`));

  // scan historical events
  const headBlock = Number(await getClient().getBlockNumber());
  console.log(
    chalk.cyan(`  scanning blocks ${STYLUS_GENESIS_BLOCK} to ${headBlock}...\n`)
  );

  // no gap between backfill and tail
  const lastProcessed = await backfill(
    cacheManager,
    STYLUS_GENESIS_BLOCK,
    headBlock,
    ac.signal
  );

  if (ac.signal.aborted) return;

  console.log(chalk.green("\n  historical scan done, switching to live tail\n"));

  // switch to live polling
  await startTail(cacheManager, lastProcessed, ac.signal);
}

async function cmdStatus() {
  console.log(chalk.cyan("\n  Stylus Cache Sentinel — status\n"));

  const cacheManager = await resolveCacheManager();
  const state = await readCacheState(cacheManager);

  const usedKb = (Number(state.queueSize) / 1024).toFixed(1);
  const totalKb = (Number(state.cacheSize) / 1024).toFixed(1);
  const freeKb = (
    (Number(state.cacheSize) - Number(state.queueSize)) /
    1024
  ).toFixed(1);

  console.log(chalk.white(`  CacheManager:  ${state.cacheManagerAddress}`));
  console.log(chalk.white(`  Cache size:    ${totalKb} KB`));
  console.log(chalk.white(`  Used:          ${usedKb} KB`));
  console.log(chalk.white(`  Free:          ${freeKb} KB`));
  console.log(chalk.white(`  Decay rate:    ${state.decay}`));
  console.log(chalk.white(`  Paused:        ${state.isPaused ? "yes" : "no"}`));
  console.log();
}

async function cmdReconcile() {
  console.log(chalk.cyan("\n  Stylus Cache Sentinel — reconcile\n"));
  const cacheManager = await resolveCacheManager();
  const report = await reconcile(cacheManager);
  printReconcileReport(report);
  process.exit(report.ok ? 0 : 1);
}

async function main() {
  const command = process.argv[2] || "sync";

  try {
    switch (command) {
      case "sync":
        await cmdSync();
        break;
      case "status":
        await cmdStatus();
        break;
      case "reconcile":
        await cmdReconcile();
        break;
      default:
        console.log("Usage: sentinel <sync|status|reconcile>");
        console.log("  sync      — scan history + tail new CacheManager events");
        console.log("  status    — show current on-chain cache state");
        console.log("  reconcile — compare DB-derived state against on-chain state");
        process.exit(1);
    }
  } catch (err: any) {
    console.error(chalk.red(`\n  error: ${err.message}\n`));
    process.exit(1);
  }
}

main();
