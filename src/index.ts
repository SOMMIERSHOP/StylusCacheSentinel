#!/usr/bin/env node
import chalk from "chalk";
import { formatEther, parseEther } from "viem";
import { resolveCacheManager } from "./resolver";
import { readCacheState } from "./indexer/state";
import { backfill } from "./indexer/backfill";
import { startTail } from "./indexer/tail";
import { reconcile, printReconcileReport } from "./indexer/reconcile";
import { getClient, setRpcUrl } from "./provider";
import { config } from "./config";
import { cacheManagerAbi, cacheManagerWriteAbi, arbWasmCacheAbi } from "./abi";
import { arbitrum } from "viem/chains";
import { parseArgs, flagString, flagBool } from "./cli/args";
import {
  initConfig,
  loadConfig,
  saveConfig,
  configPath,
  configExists,
  applyConfigSet,
  readConfigRpcUrl,
  DEFAULT_CONFIG,
  type WatchTarget,
} from "./cli/userConfig";
import { classifyInput, resolveRawTarget } from "./codehash";
import { recommendedBid, revertErrorName } from "./sentinel/assess";
import { runSentinel } from "./sentinel/run";
import {
  hasWallet,
  describeWallet,
  getAccount,
  getWalletClient,
} from "./wallet";
import { recordBidAction, updateBidAction, listRecentBidActions } from "./db/store";

// Stylus went live on Arbitrum One around Sep 3 2024.
// CacheManager was deployed as part of that same upgrade batch.
const STYLUS_GENESIS_BLOCK = 245_000_000;

// ---- M1/M2 commands (indexer) --------------------------------------------

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

  const headBlock = Number(await getClient().getBlockNumber());
  console.log(
    chalk.cyan(`  scanning blocks ${STYLUS_GENESIS_BLOCK} to ${headBlock}...\n`)
  );

  const lastProcessed = await backfill(
    cacheManager,
    STYLUS_GENESIS_BLOCK,
    headBlock,
    ac.signal
  );

  if (ac.signal.aborted) return;

  console.log(chalk.green("\n  historical scan done, switching to live tail\n"));
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
  const cacheManager = await resolveCacheManager();
  const report = await reconcile(cacheManager);
  printReconcileReport(report);
  process.exit(report.ok ? 0 : 1);
}

// ---- M3: config --------------------------------------------------------

function cmdConfig(sub: string, positionals: string[], flags: Record<string, string | boolean>) {
  switch (sub) {
    case "init": {
      const cfg = initConfig(flagBool(flags, "force"));
      console.log(chalk.green(`\n  wrote default config to ${configPath()}\n`));
      console.log(chalk.gray(JSON.stringify(cfg, null, 2)));
      console.log();
      break;
    }
    case "show": {
      if (!configExists()) {
        console.log(
          chalk.yellow(`\n  no config yet — run \`sentinel config init\`\n`)
        );
        return;
      }
      console.log();
      console.log(JSON.stringify(loadConfig(), null, 2));
      console.log();
      break;
    }
    case "path":
      console.log(configPath());
      break;
    case "set": {
      const [key, value] = positionals;
      if (!key || value === undefined) {
        throw new Error("usage: sentinel config set <key> <value>");
      }
      const cfg = loadConfig();
      const next = applyConfigSet(cfg, key, value);
      saveConfig(next);
      console.log(chalk.green(`\n  ${key} = ${value}  (validated, saved)\n`));
      break;
    }
    default:
      throw new Error("usage: sentinel config <init|show|set|path>");
  }
}

// ---- M3: watchlist -----------------------------------------------------

function cmdWatch(sub: string, positionals: string[], flags: Record<string, string | boolean>) {
  switch (sub) {
    case "add": {
      const raw = positionals[0];
      if (!raw) throw new Error("usage: sentinel watch add <program|codehash> [--label .. --max-bid .. --headroom ..]");
      const input = classifyInput(raw);
      if (!input) {
        throw new Error(`"${raw}" is not a valid program address or codehash`);
      }
      const cfg = configExists() ? loadConfig() : initConfig();

      const entry: WatchTarget = {};
      if (input.kind === "program") entry.program = input.program;
      else entry.codehash = input.codehash;
      const label = flagString(flags, "label");
      if (label) entry.label = label;
      const maxBid = flagString(flags, "max-bid");
      if (maxBid) entry.maxBidEth = maxBid;
      const headroom = flagString(flags, "headroom");
      if (headroom !== undefined) {
        const n = Number(headroom);
        if (!Number.isFinite(n)) {
          throw new Error(`--headroom must be a number, got "${headroom}"`);
        }
        entry.headroomPercent = n;
      }

      const key = (entry.program ?? entry.codehash)!.toLowerCase();
      const exists = cfg.watchlist.some(
        (t) => (t.program ?? t.codehash ?? "").toLowerCase() === key
      );
      if (exists) {
        console.log(chalk.yellow(`\n  ${raw} is already on the watchlist\n`));
        return;
      }
      cfg.watchlist.push(entry);
      saveConfig(cfg);
      console.log(chalk.green(`\n  added ${raw} to watchlist (${cfg.watchlist.length} total)`));
      if (input.kind === "codehash") {
        console.log(
          chalk.yellow(
            `  note: bidding needs the program address. If it can't be resolved\n` +
              `        (sync the indexer first), this target is monitor-only.`
          )
        );
      }
      console.log();
      break;
    }
    case "remove": {
      const raw = positionals[0];
      if (!raw) throw new Error("usage: sentinel watch remove <program|codehash>");
      const cfg = loadConfig();
      const key = raw.toLowerCase();
      const before = cfg.watchlist.length;
      cfg.watchlist = cfg.watchlist.filter(
        (t) => (t.program ?? t.codehash ?? "").toLowerCase() !== key
      );
      if (cfg.watchlist.length === before) {
        console.log(chalk.yellow(`\n  ${raw} was not on the watchlist\n`));
        return;
      }
      saveConfig(cfg);
      console.log(chalk.green(`\n  removed ${raw} (${cfg.watchlist.length} remaining)\n`));
      break;
    }
    case "list": {
      if (!configExists()) {
        console.log(chalk.yellow(`\n  no config yet — run \`sentinel config init\`\n`));
        return;
      }
      const cfg = loadConfig();
      if (cfg.watchlist.length === 0) {
        console.log(chalk.gray(`\n  watchlist is empty\n`));
        return;
      }
      console.log(chalk.cyan(`\n  watchlist (${cfg.watchlist.length}):\n`));
      for (const t of cfg.watchlist) {
        const id = t.program ?? t.codehash;
        const kind = t.program ? "program " : "codehash";
        const over = [
          t.label ? `label=${t.label}` : null,
          t.maxBidEth ? `maxBid=${t.maxBidEth}` : null,
          t.headroomPercent !== undefined ? `headroom=${t.headroomPercent}%` : null,
        ]
          .filter(Boolean)
          .join("  ");
        console.log(chalk.white(`  ${kind} ${id}${over ? "  " + chalk.gray(over) : ""}`));
      }
      console.log();
      break;
    }
    default:
      throw new Error("usage: sentinel watch <add|remove|list>");
  }
}

// ---- M3: wallet --------------------------------------------------------

async function cmdWallet(sub: string) {
  switch (sub) {
    case "address": {
      if (!hasWallet()) throw new Error("SENTINEL_PRIVATE_KEY is not set");
      console.log(chalk.white(`\n  ${getAccount().address}\n`));
      break;
    }
    case "balance": {
      if (!hasWallet()) throw new Error("SENTINEL_PRIVATE_KEY is not set");
      const w = await describeWallet();
      console.log(chalk.white(`\n  ${w.address}`));
      console.log(chalk.white(`  ${w.balanceEth} ETH\n`));
      break;
    }
    default:
      throw new Error("usage: sentinel wallet <address|balance>");
  }
}

// ---- M3: inspect a single target --------------------------------------

async function cmdInspect(positionals: string[]) {
  const raw = positionals[0];
  if (!raw) throw new Error("usage: sentinel inspect <program|codehash>");

  const cacheManager = await resolveCacheManager();
  const target = await resolveRawTarget(raw);
  const client = getClient();

  const [cached, entries] = await Promise.all([
    client.readContract({
      address: config.arbWasmCacheAddress,
      abi: arbWasmCacheAbi,
      functionName: "codehashIsCached",
      args: [target.codehash],
    }) as Promise<boolean>,
    client.readContract({
      address: cacheManager,
      abi: cacheManagerAbi,
      functionName: "getEntries",
    }) as Promise<readonly { code: `0x${string}`; size: bigint; bid: bigint }[]>,
  ]);

  // getMinBid can revert (e.g. ProgramExpired) — classify rather than crash.
  let minBidLabel: string;
  try {
    const minBidWei = (await client.readContract({
      address: cacheManager,
      abi: cacheManagerWriteAbi,
      functionName: "getMinBid",
      args: [target.codehash],
    })) as bigint;
    minBidLabel = `${formatEther(minBidWei)} ETH`;
  } catch (err) {
    const name = revertErrorName(err);
    minBidLabel = name ? chalk.yellow(`n/a (${name})`) : chalk.yellow("n/a (read reverted)");
  }

  const entry = entries.find(
    (e) => e.code.toLowerCase() === target.codehash.toLowerCase()
  );

  console.log(chalk.cyan(`\n  inspect ${raw}\n`));
  if (target.program) console.log(chalk.white(`  program:   ${target.program}`));
  console.log(chalk.white(`  codehash:  ${target.codehash}`));
  console.log(
    chalk.white(`  cached:    ${cached ? chalk.green("yes") : chalk.red("no")}`)
  );
  console.log(chalk.white(`  min bid:   ${minBidLabel}`));
  if (entry) {
    console.log(chalk.white(`  our bid:   ${formatEther(entry.bid)} ETH`));
    console.log(chalk.white(`  size:      ${entry.size} bytes`));
  } else {
    console.log(chalk.gray(`  (not currently in the cache queue)`));
  }
  console.log();
}

// ---- M3: manual bid (explicit override) -------------------------------

async function cmdBid(positionals: string[], flags: Record<string, string | boolean>) {
  const raw = positionals[0];
  if (!raw) throw new Error("usage: sentinel bid <program|codehash> [--amount <eth>] [--yes]");

  const cacheManager = await resolveCacheManager();
  const target = await resolveRawTarget(raw);
  const client = getClient();

  // placeBid is keyed on the program address — a codehash-only target we can't
  // map back to a program is monitor-only and cannot be bid on.
  if (!target.program) {
    throw new Error(
      `cannot bid on ${raw}: no program address is known for this codehash. ` +
        `placeBid requires the program address — run \`sentinel sync\` to index it, ` +
        `or pass the program address directly.`
    );
  }

  // getMinBid can revert (e.g. ProgramExpired) — classify rather than crash.
  let minBidWei: bigint;
  try {
    minBidWei = (await client.readContract({
      address: cacheManager,
      abi: cacheManagerWriteAbi,
      functionName: "getMinBid",
      args: [target.codehash],
    })) as bigint;
  } catch (err) {
    const name = revertErrorName(err);
    throw new Error(
      name
        ? `getMinBid reverted with ${name} — cannot determine a bid for ${raw}` +
          (name === "ProgramExpired" || name === "ProgramNotActivated"
            ? " (the program needs Stylus re-activation first)"
            : "")
        : `getMinBid failed: ${(err as any)?.message ?? "unknown error"}`
    );
  }

  const amountFlag = flagString(flags, "amount");
  const bidWei = amountFlag
    ? parseEther(amountFlag as `${number}`)
    : recommendedBid(minBidWei, DEFAULT_CONFIG.defaultPolicy.headroomPercent);

  console.log(chalk.cyan(`\n  manual bid for ${raw}`));
  console.log(chalk.white(`  program:  ${target.program}`));
  console.log(chalk.white(`  codehash: ${target.codehash}`));
  console.log(chalk.white(`  min bid:  ${formatEther(minBidWei)} ETH`));
  console.log(chalk.white(`  bid:      ${formatEther(bidWei)} ETH`));

  if (!flagBool(flags, "yes")) {
    console.log(
      chalk.yellow(`\n  dry-run — re-run with --yes to submit on-chain\n`)
    );
    recordBidAction({
      codehash: target.codehash,
      program: target.program,
      bidWei: bidWei.toString(),
      status: "dry-run",
      txHash: null,
      reason: "manual bid (dry-run)",
    });
    return;
  }

  if (!hasWallet()) throw new Error("SENTINEL_PRIVATE_KEY is not set");

  const wallet = getWalletClient();
  const txHash = await wallet.writeContract({
    account: getAccount(),
    chain: arbitrum,
    address: cacheManager,
    abi: cacheManagerWriteAbi,
    functionName: "placeBid",
    args: [target.program],
    value: bidWei,
  });
  const id = recordBidAction({
    codehash: target.codehash,
    program: target.program,
    bidWei: bidWei.toString(),
    status: "submitted",
    txHash,
    reason: "manual bid",
  });
  console.log(chalk.cyan(`\n  submitted: ${txHash}\n  waiting for confirmation...`));

  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status === "success") {
    updateBidAction(id, { status: "confirmed", confirmedAt: Math.floor(Date.now() / 1000) });
    console.log(chalk.green(`  confirmed in block ${receipt.blockNumber}\n`));
  } else {
    updateBidAction(id, { status: "failed" });
    console.log(chalk.red(`  transaction reverted\n`));
  }
}

// ---- M4: the sentinel loop --------------------------------------------

async function cmdRun(flags: Record<string, string | boolean>) {
  // Dry-run is the default; --live opts in to spending real ETH.
  const live = flagBool(flags, "live");
  const dryRun = !live || flagBool(flags, "dry-run");
  const once = flagBool(flags, "once");

  const ac = new AbortController();
  process.on("SIGINT", () => {
    console.log(chalk.yellow("\n  stopping..."));
    ac.abort();
  });
  process.on("SIGTERM", () => ac.abort());

  await runSentinel({ dryRun, once, signal: ac.signal });
}

// ---- history --------------------------------------------------------------

function cmdHistory(flags: Record<string, string | boolean>) {
  const limit = Number(flagString(flags, "limit") ?? "20");
  const rows = listRecentBidActions(Number.isFinite(limit) ? limit : 20);
  if (rows.length === 0) {
    console.log(chalk.gray("\n  no bid actions recorded yet\n"));
    return;
  }
  console.log(chalk.cyan(`\n  recent bid actions (${rows.length}):\n`));
  for (const r of rows) {
    const when = new Date(r.created_at * 1000).toISOString().slice(0, 19).replace("T", " ");
    const id = r.program ?? r.codehash;
    console.log(
      chalk.white(
        `  ${when}  ${r.status.padEnd(9)} ${formatEther(BigInt(r.bid_wei))} ETH  ${id.slice(0, 12)}…  ${r.reason ?? ""}`
      )
    );
  }
  console.log();
}

// ---- router ---------------------------------------------------------------

function printHelp() {
  console.log(`
  Stylus Cache Sentinel

  Indexer (M1/M2)
    sync                       scan history + tail new CacheManager events
    status                     show current on-chain cache state
    reconcile                  compare DB-derived state against on-chain

  Configuration (M3)
    config init [--force]      write a default config to ~/.sentinel/config.json
    config show                print the active config
    config set <key> <value>   set & validate a config value
    config path                print the config file path

  Watchlist (M3)
    watch add <target> [--label <s>] [--max-bid <eth>] [--headroom <pct>]
    watch remove <target>
    watch list

  Wallet (M3, env SENTINEL_PRIVATE_KEY)
    wallet address             show the active signer address
    wallet balance             show signer ETH balance

  Inspect / manual ops (M3)
    inspect <target>           cache status, min bid, current bid for one target
    bid <target> [--amount <eth>] [--yes]   manually place a bid (dry-run unless --yes)
    history [--limit <n>]      recent bid actions

  Sentinel automation (M4)
    run [--live] [--once]      monitor the watchlist & auto-bid (dry-run unless --live)

  <target> is a program address (20-byte hex) or a codehash (32-byte hex).
`);
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const { positionals, flags } = parseArgs(rest);

  // Apply a user-config RPC override (if any) before any client is created,
  // so every command honors `config set rpcUrl ...` (e.g. for Orbit chains).
  const cfgRpc = readConfigRpcUrl();
  if (cfgRpc) setRpcUrl(cfgRpc);

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
      case "config":
        cmdConfig(positionals[0], positionals.slice(1), flags);
        break;
      case "watch":
        cmdWatch(positionals[0], positionals.slice(1), flags);
        break;
      case "wallet":
        await cmdWallet(positionals[0]);
        break;
      case "inspect":
        await cmdInspect(positionals);
        break;
      case "bid":
        await cmdBid(positionals, flags);
        break;
      case "history":
        cmdHistory(flags);
        break;
      case "run":
        await cmdRun(flags);
        break;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;
      default:
        console.log(chalk.red(`  unknown command: ${command}`));
        printHelp();
        process.exit(1);
    }
  } catch (err: any) {
    console.error(chalk.red(`\n  error: ${err.message}\n`));
    process.exit(1);
  }
}

main();
