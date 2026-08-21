/**
 * Cross-checks the indexer's derived database state against live on-chain
 * CacheManager state.
 *
 * The indexer reconstructs "currently cached" entries and config values by
 * replaying persisted bid/eviction/config events; this module verifies
 * that reconstruction against direct RPC reads (`getEntries`, `cacheSize`,
 * `decay`, `isPaused`) and surfaces any drift or recorded sync gaps so
 * operators can catch missed events or replay bugs.
 *
 * @module
 */

import chalk from "chalk";
import { getClient } from "../provider";
import { cacheManagerAbi } from "../abi";
import { readCacheState } from "./state";
import {
  getCurrentlyCached,
  getLatestConfigState,
  listSyncGaps,
  getBidCount,
  getEvictionCount,
  getUniqueProgramCount,
  type CachedEntry,
} from "../db/store";

/** Result of comparing derived DB state against live on-chain CacheManager state. */
export interface ReconcileReport {
  ok: boolean; // true iff no drift and no recorded sync gaps
  queueSizeOnChain: bigint;
  queueSizeDerived: bigint;
  queueSizeDriftBytes: bigint; // on-chain minus derived; 0 means DB matches chain
  missingFromDb: { codehash: `0x${string}`; size: number }[]; // on-chain entries not reconstructable from DB
  extraInDb: { codehash: `0x${string}`; size: number }[]; // DB-derived entries with no on-chain counterpart
  configDrift: string[]; // human-readable mismatches between DB config state and live config
  syncGaps: { from_block: number; to_block: number; reason: string | null }[]; // ranges backfill/tail failed to fetch
}

/**
 * Compares database-derived cache state against a live on-chain read of
 * the CacheManager contract and reports any discrepancies.
 *
 * Fetches the current entry set, cache size, decay rate, and pause state
 * directly via RPC, and diffs them against what's derivable from persisted
 * events (`getCurrentlyCached`, `getLatestConfigState`) plus any gaps
 * recorded by the backfill/tail retry logic (`listSyncGaps`). Read-only —
 * performs no writes.
 *
 * @param cacheManagerAddr - address of the CacheManager contract to reconcile against
 * @returns a report describing queue-size drift, missing/extra cache entries, config drift, and outstanding sync gaps
 */
export async function reconcile(
  cacheManagerAddr: `0x${string}`
): Promise<ReconcileReport> {
  const client = getClient();
  const live = await readCacheState(cacheManagerAddr);

  const onChainEntries = (await client.readContract({
    address: cacheManagerAddr,
    abi: cacheManagerAbi,
    functionName: "getEntries",
  })) as readonly { code: `0x${string}`; size: bigint; bid: bigint }[];

  const derived = getCurrentlyCached();
  const derivedMap = new Map<string, CachedEntry>();
  for (const d of derived) derivedMap.set(d.codehash.toLowerCase(), d);

  const onChainMap = new Map<string, { codehash: `0x${string}`; size: number }>();
  for (const e of onChainEntries) {
    onChainMap.set(e.code.toLowerCase(), {
      codehash: e.code,
      size: Number(e.size),
    });
  }

  const missingFromDb: { codehash: `0x${string}`; size: number }[] = [];
  for (const [k, v] of onChainMap) {
    if (!derivedMap.has(k)) missingFromDb.push(v);
  }
  const extraInDb: { codehash: `0x${string}`; size: number }[] = [];
  for (const [k, v] of derivedMap) {
    if (!onChainMap.has(k)) extraInDb.push(v);
  }

  const queueSizeDerived = derived.reduce(
    (acc, r) => acc + BigInt(r.size),
    0n
  );
  const queueSizeDriftBytes = live.queueSize - queueSizeDerived;

  const latestConfig = getLatestConfigState();
  const configDrift: string[] = [];
  if (
    latestConfig.cacheSize !== null &&
    BigInt(latestConfig.cacheSize) !== live.cacheSize
  ) {
    configDrift.push(
      `cacheSize: db=${latestConfig.cacheSize} on-chain=${live.cacheSize}`
    );
  }
  if (
    latestConfig.decay !== null &&
    BigInt(latestConfig.decay) !== live.decay
  ) {
    configDrift.push(
      `decay: db=${latestConfig.decay} on-chain=${live.decay}`
    );
  }
  if (
    latestConfig.paused !== null &&
    latestConfig.paused !== live.isPaused
  ) {
    configDrift.push(
      `paused: db=${latestConfig.paused} on-chain=${live.isPaused}`
    );
  }

  const syncGaps = listSyncGaps();

  const ok =
    queueSizeDriftBytes === 0n &&
    missingFromDb.length === 0 &&
    extraInDb.length === 0 &&
    configDrift.length === 0 &&
    syncGaps.length === 0;

  return {
    ok,
    queueSizeOnChain: live.queueSize,
    queueSizeDerived,
    queueSizeDriftBytes,
    missingFromDb,
    extraInDb,
    configDrift,
    syncGaps,
  };
}

/**
 * Pretty-prints a `ReconcileReport` to the console (summary counts, drift
 * details, and an overall OK/DRIFT verdict). Purely for CLI output; has no
 * effect on persisted state or the report's `ok` determination.
 *
 * @param r - report produced by `reconcile`
 */
export function printReconcileReport(r: ReconcileReport): void {
  console.log(chalk.cyan("\n  Stylus Cache Sentinel — reconcile\n"));
  console.log(
    chalk.white(`  bids stored:       ${getBidCount().toLocaleString()}`)
  );
  console.log(
    chalk.white(`  evictions stored:  ${getEvictionCount().toLocaleString()}`)
  );
  console.log(
    chalk.white(`  unique programs:   ${getUniqueProgramCount().toLocaleString()}`)
  );

  console.log();
  console.log(
    chalk.white(
      `  queue size (on-chain):   ${r.queueSizeOnChain.toString()} bytes`
    )
  );
  console.log(
    chalk.white(
      `  queue size (derived):    ${r.queueSizeDerived.toString()} bytes`
    )
  );
  const driftColor =
    r.queueSizeDriftBytes === 0n ? chalk.green : chalk.red;
  console.log(
    driftColor(`  drift:                   ${r.queueSizeDriftBytes.toString()} bytes`)
  );

  if (r.missingFromDb.length > 0) {
    console.log(
      chalk.red(
        `\n  ${r.missingFromDb.length} codehash(es) on-chain but not derived from DB:`
      )
    );
    for (const m of r.missingFromDb.slice(0, 10)) {
      console.log(chalk.red(`    ${m.codehash}  size=${m.size}`));
    }
    if (r.missingFromDb.length > 10) {
      console.log(chalk.red(`    ... and ${r.missingFromDb.length - 10} more`));
    }
  }

  if (r.extraInDb.length > 0) {
    console.log(
      chalk.red(
        `\n  ${r.extraInDb.length} codehash(es) in DB but not on-chain:`
      )
    );
    for (const m of r.extraInDb.slice(0, 10)) {
      console.log(chalk.red(`    ${m.codehash}  size=${m.size}`));
    }
    if (r.extraInDb.length > 10) {
      console.log(chalk.red(`    ... and ${r.extraInDb.length - 10} more`));
    }
  }

  if (r.configDrift.length > 0) {
    console.log(chalk.red(`\n  config drift:`));
    for (const d of r.configDrift) console.log(chalk.red(`    ${d}`));
  }

  if (r.syncGaps.length > 0) {
    console.log(
      chalk.red(`\n  ${r.syncGaps.length} sync gap(s) recorded:`)
    );
    for (const g of r.syncGaps.slice(0, 10)) {
      console.log(
        chalk.red(
          `    blocks ${g.from_block}..${g.to_block}${g.reason ? `  (${g.reason})` : ""}`
        )
      );
    }
    if (r.syncGaps.length > 10) {
      console.log(chalk.red(`    ... and ${r.syncGaps.length - 10} more`));
    }
  }

  console.log();
  if (r.ok) {
    console.log(chalk.green("  OK — derived state matches on-chain state\n"));
  } else {
    console.log(chalk.red("  DRIFT — see above; consider re-running sync\n"));
  }
}
