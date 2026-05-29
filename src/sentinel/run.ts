import chalk from "chalk";
import { parseEther, formatEther } from "viem";
import { resolveCacheManager } from "../resolver";
import { readCacheState } from "../indexer/state";
import { reconcile } from "../indexer/reconcile";
import { cacheManagerAbi } from "../abi";
import { getClient, detectAndEnableMulticall } from "../provider";
import { resolveTarget, type ResolvedTarget } from "../codehash";
import { hasWallet, describeWallet } from "../wallet";
import {
  loadConfig,
  type UserConfig,
  type WatchTarget,
} from "../cli/userConfig";
import { assessTarget, type TickContext } from "./assess";
import { executeBid, colorForOutcome, type BidLimits } from "./bidder";

export interface RunOptions {
  dryRun: boolean;
  once: boolean;
  signal: AbortSignal;
}

interface PreparedTarget {
  resolved: ResolvedTarget;
  label: string;
  maxBidEth: string;
  headroomPercent: number;
}

function shortHex(hex: string): string {
  return `${hex.slice(0, 10)}…${hex.slice(-6)}`;
}

function labelFor(t: WatchTarget, resolved: ResolvedTarget): string {
  if (t.label) return t.label;
  if (resolved.program) return shortHex(resolved.program);
  return shortHex(resolved.codehash);
}

async function prepareTargets(
  cfg: UserConfig
): Promise<PreparedTarget[]> {
  const prepared: PreparedTarget[] = [];
  for (const t of cfg.watchlist) {
    const input = t.program
      ? ({ kind: "program", program: t.program } as const)
      : ({ kind: "codehash", codehash: t.codehash! } as const);
    try {
      const resolved = await resolveTarget(input);
      prepared.push({
        resolved,
        label: labelFor(t, resolved),
        maxBidEth: t.maxBidEth ?? cfg.defaultPolicy.maxBidEth,
        headroomPercent: t.headroomPercent ?? cfg.defaultPolicy.headroomPercent,
      });
    } catch (err: any) {
      console.error(
        chalk.yellow(
          `  skipping watch target ${t.program ?? t.codehash}: ${err.message}`
        )
      );
    }
  }
  return prepared;
}

// Re-resolve the watchlist and report any program whose codehash changed
// (redeploy / re-activation). Falls back to the previous set if re-resolution
// turns up nothing (e.g. a transient RPC blip).
async function refreshTargets(
  cfg: UserConfig,
  previous: PreparedTarget[]
): Promise<PreparedTarget[]> {
  const refreshed = await prepareTargets(cfg);
  if (refreshed.length === 0) return previous;

  const oldByProgram = new Map<string, string>();
  for (const p of previous) {
    if (p.resolved.program) {
      oldByProgram.set(p.resolved.program.toLowerCase(), p.resolved.codehash);
    }
  }
  for (const t of refreshed) {
    if (!t.resolved.program) continue;
    const old = oldByProgram.get(t.resolved.program.toLowerCase());
    if (old && old !== t.resolved.codehash) {
      console.log(
        chalk.yellow(
          `  [${ts()}] ${t.label}: codehash changed ${shortHex(old)} -> ` +
            `${shortHex(t.resolved.codehash)} (redeploy/re-activation)`
        )
      );
    }
  }
  return refreshed;
}

async function buildTickContext(
  cacheManager: `0x${string}`
): Promise<TickContext> {
  const client = getClient();
  const state = await readCacheState(cacheManager);
  const block = await client.getBlock();
  // NOTE: getEntries() returns the entire cache and is O(cache size) per tick.
  // Fine at current scale; revisit (e.g. event-derived local view) if the
  // cache grows large enough that this read dominates the poll loop.
  const entries = (await client.readContract({
    address: cacheManager,
    abi: cacheManagerAbi,
    functionName: "getEntries",
  })) as readonly { code: `0x${string}`; size: bigint; bid: bigint }[];

  const entryMap = new Map<string, { bidStoredWei: bigint; sizeBytes: bigint }>();
  for (const e of entries) {
    entryMap.set(e.code.toLowerCase(), { bidStoredWei: e.bid, sizeBytes: e.size });
  }

  const freeBytes = state.cacheSize - state.queueSize;
  const decayOffsetWei = block.timestamp * state.decay;
  return { cacheManager, freeBytes, decayOffsetWei, entries: entryMap };
}

export async function runSentinel(opts: RunOptions): Promise<void> {
  const startedAt = Date.now();
  const cfg = loadConfig();

  console.log(
    chalk.cyan(
      `\n  Stylus Cache Sentinel — run ${opts.dryRun ? "(dry-run)" : chalk.bold("(LIVE)")}\n`
    )
  );

  if (cfg.watchlist.length === 0) {
    console.log(
      chalk.yellow(
        "  watchlist is empty — add targets with `sentinel watch add <program|codehash>`\n"
      )
    );
    return;
  }

  // Live mode needs a funded signer.
  if (!opts.dryRun) {
    if (!hasWallet()) {
      throw new Error(
        "Live mode requires SENTINEL_PRIVATE_KEY to be set. " +
          "Run with --dry-run to simulate without a wallet."
      );
    }
    const w = await describeWallet();
    console.log(
      chalk.white(`  signer: ${w.address}  balance: ${w.balanceEth} ETH\n`)
    );
  }

  const cacheManager = await resolveCacheManager();
  console.log(chalk.white(`  CacheManager: ${cacheManager}`));

  // Batch reads via Multicall3 where available (the throughput fix for large
  // watchlists); otherwise fall back to chunked concurrent reads below.
  const multicall = await detectAndEnableMulticall();
  console.log(
    chalk.gray(
      `  read batching: ${multicall ? "multicall3 enabled" : "unavailable — chunked reads"}`
    )
  );

  let targets = await prepareTargets(cfg);
  if (targets.length === 0) {
    console.log(chalk.yellow("\n  no resolvable watch targets — nothing to do\n"));
    return;
  }

  const limits: BidLimits = {
    cacheManager,
    maxSpendPerWindowWei: parseEther(cfg.maxSpendPerWindowEth as `${number}`),
    spendWindowSeconds: cfg.spendWindowHours * 3600,
    dryRun: opts.dryRun,
    receiptTimeoutMs: 120_000,
  };

  console.log(
    chalk.white(
      `  watching ${targets.length} target(s), poll ${cfg.pollIntervalMs}ms, ` +
        `spend cap ${cfg.maxSpendPerWindowEth} ETH / ${cfg.spendWindowHours}h`
    )
  );
  console.log(
    chalk.gray(`  startup completed in ${Date.now() - startedAt}ms\n`)
  );

  // Per-codehash cooldown: after we act on a target we hold off for
  // bidCooldownSeconds. This stops the loop from re-recording a dry-run row
  // every tick, and from resubmitting a live bid that is still pending /
  // propagating before the next poll.
  const cooldownUntil = new Map<string, number>();
  const cooldownMs = cfg.bidCooldownSeconds * 1000;

  // Periodically re-resolve program→codehash so a redeploy/re-activation while
  // the loop runs is eventually picked up (a "set-and-forget" tool shouldn't
  // need a restart). Cheap for indexed programs (DB lookup); for un-indexed
  // ones it re-derives from on-chain code.
  const RESOLVE_REFRESH_MS = 10 * 60 * 1000;
  let lastResolveAt = Date.now();

  // Cap simultaneous in-flight assessment reads. Concurrency cuts wall-clock,
  // but an unbounded fan-out at 50+ targets would burst ~2N eth_calls at once
  // and trip public-RPC rate limits; chunking keeps the burst bounded. (The
  // throughput fix is multicall batching — noted at the call site.)
  const ASSESS_CONCURRENCY = 10;

  do {
    if (opts.signal.aborted) break;
    const tickStart = Date.now();

    try {
      if (cfg.haltOnDrift && !opts.dryRun) {
        const report = await reconcile(cacheManager);
        if (!report.ok) {
          console.log(
            chalk.red(
              `  [${ts()}] reconcile drift detected — bidding halted this tick ` +
                `(drift ${report.queueSizeDriftBytes} bytes, ${report.syncGaps.length} gap(s))`
            )
          );
          // In one-shot mode, a halt still counts as the single pass — don't
          // loop forever waiting for drift to clear (matters for cron/one-shot).
          if (opts.once) break;
          await abortableSleep(cfg.pollIntervalMs, opts.signal);
          continue;
        }
      }

      if (!opts.once && Date.now() - lastResolveAt > RESOLVE_REFRESH_MS) {
        targets = await refreshTargets(cfg, targets);
        lastResolveAt = Date.now();
        // Drop cooldown entries for codehashes no longer on the (re-resolved)
        // watchlist, so a redeploy can't leak stale keys into the map.
        const live = new Set(targets.map((t) => t.resolved.codehash.toLowerCase()));
        for (const k of cooldownUntil.keys()) {
          if (!live.has(k)) cooldownUntil.delete(k);
        }
      }

      const ctx = await buildTickContext(cacheManager);

      // Assess targets in bounded-concurrency chunks — read-only, so fanning
      // out cuts per-tick wall-clock, while the chunk cap keeps the eth_call
      // burst bounded against rate-limited RPCs. When multicall3 is available
      // each chunk's concurrent reads are additionally batched into a single
      // request (the real throughput fix); chunking is the fallback otherwise.
      // Acting stays strictly serial below so the per-window spend cap is
      // accounted for in order.
      const assessments: Awaited<ReturnType<typeof assessTarget>>[] = [];
      for (let i = 0; i < targets.length; i += ASSESS_CONCURRENCY) {
        const slice = targets.slice(i, i + ASSESS_CONCURRENCY);
        assessments.push(
          ...(await Promise.all(
            slice.map((t) =>
              assessTarget(ctx, t.resolved, t.label, t.maxBidEth, t.headroomPercent)
            )
          ))
        );
      }

      for (const a of assessments) {
        if (opts.signal.aborted) break;

        if (a.error) {
          console.log(
            chalk.yellow(`  [${ts()}] ${a.label}: read error — ${a.error}`)
          );
          continue;
        }

        const status = a.cached ? chalk.green("cached") : chalk.red("NOT cached");
        const minEth = formatEther(a.minBidWei);

        if (!a.decision.needsBid) {
          console.log(
            chalk.gray(
              `  [${ts()}] ${a.label}: ${status}, minBid ${minEth} ETH — ${a.decision.reason}`
            )
          );
          continue;
        }

        // Cooldown gate: skip silently if we acted on this target recently.
        const key = a.target.codehash.toLowerCase();
        if (Date.now() < (cooldownUntil.get(key) ?? 0)) continue;

        const result = await executeBid(a, limits);
        cooldownUntil.set(key, Date.now() + cooldownMs);
        const color = colorForOutcome(result.outcome);
        console.log(
          color(
            `  [${ts()}] ${a.label}: ${status}, minBid ${minEth} ETH — ` +
              `${result.outcome.toUpperCase()}: ${result.note}`
          )
        );
      }
    } catch (err: any) {
      console.error(chalk.yellow(`  [${ts()}] tick error: ${err.message}`));
    }

    if (opts.once) break;

    const elapsed = Date.now() - tickStart;
    const wait = Math.max(0, cfg.pollIntervalMs - elapsed);
    await abortableSleep(wait, opts.signal);
  } while (!opts.signal.aborted);

  console.log(chalk.cyan("\n  sentinel stopped\n"));
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
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
