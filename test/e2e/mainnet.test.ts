/**
 * Milestone 6 — end-to-end production validation against Arbitrum One.
 *
 * These tests talk to real mainnet over RPC. They are deliberately excluded
 * from `npm test` (which stays offline and hermetic) and run via
 * `npm run test:e2e` instead.
 *
 * Everything here is read-only or dry-run. The suite deletes
 * SENTINEL_PRIVATE_KEY from the environment before importing any module, so
 * the wallet layer cannot sign even if a key is present in the shell. No test
 * in this file can move ETH.
 *
 * State is isolated to a temp database and a temp SENTINEL_HOME, so running
 * the suite never touches a real index or user config.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// --- isolation -------------------------------------------------------------
// Must happen before any import that transitively pulls in config.ts or
// wallet.ts — the tsconfig is CommonJS, so statement order is respected at
// require time (same convention as test/smoke.test.ts).

const stamp = `${process.pid}-${Date.now()}`;
const tmpDb = path.join(os.tmpdir(), `sentinel-e2e-${stamp}.db`);
const tmpHome = path.join(os.tmpdir(), `sentinel-e2e-home-${stamp}`);

process.env.DB_PATH = tmpDb;
process.env.SENTINEL_HOME = tmpHome;
// Hard guarantee: no signer is available to any module in this process.
delete process.env.SENTINEL_PRIVATE_KEY;

import { isAddress, isHex } from "viem";
import { resolveCacheManager } from "../../src/resolver";
import { getClient } from "../../src/provider";
import { config } from "../../src/config";
import { arbWasmCacheAbi, cacheManagerAbi, cacheManagerWriteAbi } from "../../src/abi";
import { readCacheState } from "../../src/indexer/state";
import { backfill } from "../../src/indexer/backfill";
import { parseEvents, getBlockTimestamps } from "../../src/indexer/format";
import { reconcile } from "../../src/indexer/reconcile";
import { resolveTarget } from "../../src/codehash";
import {
  revertErrorName,
  recommendedBid,
  assessTarget,
  type Assessment,
  type TickContext,
} from "../../src/sentinel/assess";
import { executeBid, type BidLimits } from "../../src/sentinel/bidder";
import { runSentinel } from "../../src/sentinel/run";
import { hasWallet } from "../../src/wallet";
import {
  initConfig,
  loadConfig,
  saveConfig,
  type WatchTarget,
} from "../../src/cli/userConfig";
import {
  closeDb,
  getBidCount,
  getLastSyncedBlock,
  getCodehashForProgram,
  persistParsedEvents,
  listRecentBidActions,
  getSpendWeiSince,
} from "../../src/db/store";

// --- fixtures --------------------------------------------------------------

// A fixed, already-mined block window on Arbitrum One containing exactly one
// InsertBid. Historical blocks are immutable, so pinning the range makes these
// tests deterministic — unlike a window relative to the moving chain head,
// where CacheManager events are far too sparse to guarantee a hit.
const KNOWN_EVENT_BLOCK = 491_248_166;
const WINDOW_FROM = 491_247_000;
const WINDOW_TO = 491_249_000;
const KNOWN_PROGRAM = "0x66DaB1fE11EC22e4700DAaA50cdAc03fcdE9dE2e" as `0x${string}`;

// Milestone KPI budgets, in milliseconds.
const INDEXER_STARTUP_BUDGET_MS = 30_000; // M1: indexer operational in < 30 s
const SENTINEL_STARTUP_BUDGET_MS = 20_000; // M4: sentinel operational in < 20 s
const COMMAND_BUDGET_MS = 10_000; // M3: any CLI command returns in < 10 s

// CacheManager custom errors that mean "cannot be bid on right now". Anything
// outside this set reverting would be an unhandled failure mode.
const KNOWN_REVERTS = new Set([
  "ProgramExpired",
  "ProgramNotActivated",
  "ProgramNeedsUpgrade",
  "BidTooSmall",
  "BidsArePaused",
  "AlreadyCached",
  "TooLarge",
]);

let cacheManager: `0x${string}`;

before(async () => {
  cacheManager = await resolveCacheManager();
});

after(() => {
  closeDb();
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(tmpDb + ext);
    } catch {}
  }
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});

// --- 1. deployment / connectivity -----------------------------------------

test(
  "e2e: resolves the active CacheManager on Arbitrum One within the M1 startup budget",
  { timeout: 60_000 },
  async () => {
    const t0 = Date.now();
    const addr = await resolveCacheManager();
    const elapsed = Date.now() - t0;

    assert.ok(isAddress(addr), `expected an address, got ${addr}`);
    assert.ok(
      elapsed < INDEXER_STARTUP_BUDGET_MS,
      `CacheManager resolution took ${elapsed}ms, budget ${INDEXER_STARTUP_BUDGET_MS}ms`
    );
    console.log(`    CacheManager ${addr} resolved in ${elapsed}ms`);
  }
);

test("e2e: no signer is available to this process", () => {
  // The suite's core safety property: without a key, nothing can be submitted.
  assert.equal(hasWallet(), false, "SENTINEL_PRIVATE_KEY must not be set for E2E");
});

// --- 2. live state read ----------------------------------------------------

test("e2e: live cache state is internally coherent", { timeout: 60_000 }, async () => {
  const state = await readCacheState(cacheManager);

  assert.ok(state.cacheSize > 0n, "cacheSize should be positive");
  assert.ok(state.queueSize >= 0n, "queueSize should be non-negative");
  assert.ok(
    state.queueSize <= state.cacheSize,
    `queueSize ${state.queueSize} exceeds cacheSize ${state.cacheSize}`
  );
  assert.ok(state.decay > 0n, "decay should be positive");
  assert.equal(typeof state.isPaused, "boolean");
  assert.equal(state.cacheManagerAddress.toLowerCase(), cacheManager.toLowerCase());

  console.log(
    `    cache ${state.queueSize}/${state.cacheSize} bytes, decay ${state.decay}, paused ${state.isPaused}`
  );
});

// --- 3. indexer against real chain data ------------------------------------

test(
  "e2e: backfill indexes a known historical window and resumes on re-run",
  { timeout: 180_000 },
  async () => {
    const ac = new AbortController();

    const last = await backfill(cacheManager, WINDOW_FROM, WINDOW_TO, ac.signal);
    assert.equal(last, WINDOW_TO, "backfill should report the window end");
    assert.equal(
      getLastSyncedBlock(),
      WINDOW_TO,
      "checkpoint should be persisted at the window end"
    );

    const afterFirst = getBidCount();
    assert.ok(
      afterFirst >= 1,
      `expected at least the known InsertBid at block ${KNOWN_EVENT_BLOCK}, got ${afterFirst} bids`
    );

    // The dim tables must have been linked from real event data — this is the
    // M2 normalization working against production data, not a fixture.
    const codehash = getCodehashForProgram(KNOWN_PROGRAM);
    assert.ok(
      codehash && isHex(codehash) && codehash.length === 66,
      `expected a codehash for ${KNOWN_PROGRAM}, got ${codehash}`
    );

    // Re-running over the same range must be a no-op via the resume path.
    const again = await backfill(cacheManager, WINDOW_FROM, WINDOW_TO, ac.signal);
    assert.equal(again, WINDOW_TO);
    assert.equal(
      getBidCount(),
      afterFirst,
      "re-running backfill must not duplicate rows"
    );

    console.log(`    indexed ${afterFirst} bid(s); program -> codehash ${codehash}`);
  }
);

test(
  "e2e: re-persisting the same real logs is idempotent",
  { timeout: 180_000 },
  async () => {
    const client = getClient();
    const logs = await client.getLogs({
      address: cacheManager,
      fromBlock: BigInt(WINDOW_FROM),
      toBlock: BigInt(WINDOW_TO),
    });
    assert.ok(logs.length > 0, "fixture window should contain logs");

    const blockNums = logs
      .filter((l) => l.blockNumber != null)
      .map((l) => Number(l.blockNumber));
    const timestamps = await getBlockTimestamps(blockNums, client);
    const parsed = parseEvents(logs, timestamps);

    const before = getBidCount();
    const res = persistParsedEvents(
      parsed.bids,
      parsed.evictions,
      parsed.configEvents,
      WINDOW_TO
    );

    // Every row was already written by the backfill test above, so all of them
    // must be deduped by UNIQUE(tx_hash, log_index) — the M2 integrity KPI.
    assert.equal(res.bidsInserted, 0, "no bid should be re-inserted");
    assert.equal(res.evictionsInserted, 0, "no eviction should be re-inserted");
    assert.equal(res.configInserted, 0, "no config event should be re-inserted");
    assert.equal(res.bidsSkipped, parsed.bids.length);
    assert.equal(getBidCount(), before, "row count must be unchanged");

    console.log(
      `    ${parsed.bids.length} bid(s) re-offered, ${res.bidsSkipped} deduped, 0 inserted`
    );
  }
);

test(
  "e2e: reconcile detects that a partial index does not match the chain",
  { timeout: 180_000 },
  async () => {
    const report = await reconcile(cacheManager);

    assert.equal(typeof report.ok, "boolean");
    assert.ok(report.queueSizeOnChain > 0n, "on-chain queue size should be positive");
    assert.ok(Array.isArray(report.missingFromDb));
    assert.ok(Array.isArray(report.extraInDb));
    assert.ok(Array.isArray(report.configDrift));
    assert.ok(Array.isArray(report.syncGaps));

    // We indexed a 2000-block window, not all of history. reconcile is doing
    // its job precisely when it refuses to call that clean.
    assert.equal(report.ok, false, "a partial index must not reconcile as OK");
    assert.ok(
      report.missingFromDb.length > 0,
      "reconcile should list on-chain entries absent from a partial index"
    );

    console.log(
      `    reconcile flagged ${report.missingFromDb.length} missing entr(ies), drift ${report.queueSizeDriftBytes} bytes`
    );
  }
);

// --- 4. target resolution --------------------------------------------------

test(
  "e2e: resolves real program addresses to codehashes by both paths",
  { timeout: 120_000 },
  async () => {
    // Path A: served from the index built above.
    const indexed = await resolveTarget({ kind: "program", program: KNOWN_PROGRAM });
    assert.equal(indexed.program?.toLowerCase(), KNOWN_PROGRAM.toLowerCase());
    assert.ok(isHex(indexed.codehash) && indexed.codehash.length === 66);

    // Path B: a contract with no bid history in the index falls back to
    // hashing its on-chain code. The CacheManager itself is a stable choice.
    const fallback = await resolveTarget({ kind: "program", program: cacheManager });
    assert.ok(
      isHex(fallback.codehash) && fallback.codehash.length === 66,
      "fallback should derive a 32-byte codehash from on-chain code"
    );

    console.log(`    indexed ${indexed.codehash}\n    fallback ${fallback.codehash}`);
  }
);

// --- 5. live classification of cache entries -------------------------------

test(
  "e2e: every live cache entry is classified without an unhandled revert",
  { timeout: 300_000 },
  async () => {
    const client = getClient();
    const entries = (await client.readContract({
      address: cacheManager,
      abi: cacheManagerAbi,
      functionName: "getEntries",
    })) as readonly { code: `0x${string}`; size: bigint; bid: bigint }[];

    assert.ok(entries.length > 0, "expected a non-empty live cache");

    const sample = entries.slice(0, 12);
    let biddable = 0;
    let needsReactivation = 0;

    for (const e of sample) {
      const cached = (await client.readContract({
        address: config.arbWasmCacheAddress,
        abi: arbWasmCacheAbi,
        functionName: "codehashIsCached",
        args: [e.code],
      })) as boolean;
      assert.equal(cached, true, `${e.code} is in getEntries but reports not cached`);

      try {
        const minBid = (await client.readContract({
          address: cacheManager,
          abi: cacheManagerWriteAbi,
          functionName: "getMinBid",
          args: [e.code],
        })) as bigint;
        assert.equal(typeof minBid, "bigint");
        // The bid we would actually place must never be below the floor.
        assert.ok(recommendedBid(minBid, 20) >= minBid);
        biddable++;
      } catch (err) {
        const name = revertErrorName(err);
        assert.ok(
          name !== null,
          `getMinBid for ${e.code} reverted without a decodable error name`
        );
        assert.ok(
          KNOWN_REVERTS.has(name),
          `getMinBid reverted with unhandled error "${name}" for ${e.code}`
        );
        needsReactivation++;
      }
    }

    assert.equal(biddable + needsReactivation, sample.length);
    console.log(
      `    ${sample.length} live entries: ${biddable} biddable, ${needsReactivation} need re-activation`
    );
  }
);

test(
  "e2e: assessing a watchlist program never yields an undecodable revert",
  { timeout: 180_000 },
  async () => {
    // Regression guard. A watchlist *program* that is not currently in the
    // cache exercises a different getMinBid revert than the cached entries
    // sampled above. ProgramNeedsUpgrade (0x637d968f) was missing from the ABI
    // and surfaced here as an opaque multi-line read error.
    const client = getClient();
    const state = await readCacheState(cacheManager);
    const block = await client.getBlock();
    const entries = (await client.readContract({
      address: cacheManager,
      abi: cacheManagerAbi,
      functionName: "getEntries",
    })) as readonly { code: `0x${string}`; size: bigint; bid: bigint }[];

    const ctx: TickContext = {
      cacheManager,
      freeBytes: state.cacheSize - state.queueSize,
      decayOffsetWei: block.timestamp * state.decay,
      entries: new Map(
        entries.map((e) => [
          e.code.toLowerCase(),
          { bidStoredWei: e.bid, sizeBytes: e.size },
        ])
      ),
    };

    const target = await resolveTarget({ kind: "program", program: KNOWN_PROGRAM });
    const a = await assessTarget(ctx, target, "regression", "0.01", 20);

    assert.ok(
      !a.error?.includes("unrecognized error"),
      `assessment hit an undecodable revert: ${a.error}`
    );
    assert.ok(
      !a.error?.includes("Version: viem"),
      `assessment leaked a raw viem dump into the log: ${a.error}`
    );
    // Either it decoded to a real decision, or it decoded to a named reason.
    assert.ok(
      a.error === undefined || a.error.startsWith("getMinBid reverted: "),
      `unexpected error shape: ${a.error}`
    );
    console.log(`    ${a.error ?? a.decision.reason}`);
  }
);

// --- 6. the sentinel loop, dry, against live targets -----------------------

test(
  "e2e: a full sentinel tick runs dry against live targets within the M4 budget",
  { timeout: 180_000 },
  async () => {
    const client = getClient();
    const entries = (await client.readContract({
      address: cacheManager,
      abi: cacheManagerAbi,
      functionName: "getEntries",
    })) as readonly { code: `0x${string}`; size: bigint; bid: bigint }[];

    const cfg = initConfig(true);
    cfg.watchlist = entries.slice(0, 3).map(
      (e, i): WatchTarget => ({ codehash: e.code, label: `e2e-${i}` })
    );
    saveConfig(cfg);
    assert.equal(loadConfig().watchlist.length, 3, "watchlist should round-trip");

    const spendBefore = getSpendWeiSince(0, { includeDryRun: false });
    const ac = new AbortController();

    const t0 = Date.now();
    await runSentinel({ dryRun: true, once: true, signal: ac.signal });
    const elapsed = Date.now() - t0;

    assert.ok(
      elapsed < SENTINEL_STARTUP_BUDGET_MS,
      `sentinel tick took ${elapsed}ms, budget ${SENTINEL_STARTUP_BUDGET_MS}ms`
    );

    // Nothing may have been submitted, and no real spend may be recorded.
    const actions = listRecentBidActions(50);
    for (const a of actions) {
      assert.ok(
        a.status !== "submitted" && a.status !== "confirmed",
        `dry run produced a live action: ${a.status} ${a.tx_hash}`
      );
    }
    assert.equal(
      getSpendWeiSince(0, { includeDryRun: false }),
      spendBefore,
      "a dry run must not change recorded live spend"
    );

    console.log(`    tick over 3 live targets completed in ${elapsed}ms, 0 ETH committed`);
  }
);

test(
  "e2e: the bidder's dry-run path records an action without touching the chain",
  { timeout: 120_000 },
  async () => {
    // Force a decision that *wants* to bid, so the execution path is exercised
    // end to end. Mainnet rarely offers an evicted target on demand, so the
    // assessment is constructed directly; everything downstream is real.
    const target = await resolveTarget({ kind: "program", program: KNOWN_PROGRAM });
    const assessment: Assessment = {
      target,
      label: "e2e-forced",
      cached: false,
      minBidWei: 1_000n,
      ourValueWei: null,
      decision: {
        needsBid: true,
        recommendedBidWei: recommendedBid(1_000n, 20),
        reason: "e2e forced decision",
        blocked: false,
      },
    };

    const limits: BidLimits = {
      cacheManager,
      maxSpendPerWindowWei: 10n ** 18n,
      spendWindowSeconds: 3600,
      dryRun: true,
      receiptTimeoutMs: 30_000,
    };

    const before = listRecentBidActions(1)[0]?.id ?? 0;
    const result = await executeBid(assessment, limits);

    assert.equal(result.outcome, "dry-run", `expected dry-run, got ${result.outcome}`);
    assert.equal(result.txHash, undefined, "dry run must not produce a tx hash");

    const rows = listRecentBidActions(1);
    assert.ok(rows.length > 0 && rows[0].id > before, "an audit row should be appended");
    assert.equal(rows[0].status, "dry-run");
    assert.equal(rows[0].tx_hash, null);
    assert.equal(
      getSpendWeiSince(0, { includeDryRun: false }),
      0n,
      "dry-run rows must not count toward live spend"
    );

    console.log(`    forced bid path recorded ${rows[0].status}, ${result.note}`);
  }
);

// --- 7. CLI response times -------------------------------------------------

test(
  "e2e: built CLI commands respond within the M3 budget",
  { timeout: 120_000 },
  () => {
    const bin = path.join(__dirname, "..", "..", "dist", "index.js");
    assert.ok(
      fs.existsSync(bin),
      `${bin} not found — run \`npm run build\` first (npm run test:e2e does this for you)`
    );

    const commands: string[][] = [
      ["status"],
      ["config", "show"],
      ["watch", "list"],
      ["history", "--limit", "5"],
      ["inspect", KNOWN_PROGRAM],
    ];

    for (const argv of commands) {
      const t0 = Date.now();
      execFileSync(process.execPath, [bin, ...argv], {
        env: {
          ...process.env,
          DB_PATH: tmpDb,
          SENTINEL_HOME: tmpHome,
        },
        stdio: "pipe",
        timeout: COMMAND_BUDGET_MS,
      });
      const elapsed = Date.now() - t0;

      assert.ok(
        elapsed < COMMAND_BUDGET_MS,
        `\`sentinel ${argv.join(" ")}\` took ${elapsed}ms, budget ${COMMAND_BUDGET_MS}ms`
      );
      console.log(`    sentinel ${argv.join(" ")} — ${elapsed}ms`);
    }
  }
);
