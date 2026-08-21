/**
 * Drives the sentinel's poll loop: resolves watch targets, reads on-chain cache
 * state once per tick, assesses each target, and executes bids for any that
 * need one — with drift-halt, cooldown, and periodic re-resolution safety nets.
 *
 * This is the orchestration layer; the actual bid decision and execution
 * logic live in ./assess and ./bidder respectively.
 *
 * @module
 */
import chalk from "chalk";
import { parseEther, formatEther } from "viem";
import { resolveCacheManager } from "../resolver";
import { readCacheState } from "../indexer/state";
import { reconcile } from "../indexer/reconcile";
import { cacheManagerAbi } from "../abi";
import { getClient, detectAndEnableMulticall, resolveChain } from "../provider";
import { config } from "../config";
import { getLastBidActionAtMs } from "../db/store";
import { resolveTarget, type ResolvedTarget } from "../codehash";
import { hasWallet, describeWallet } from "../wallet";
import {
  loadConfig,
  type UserConfig,
  type WatchTarget,
} from "../cli/userConfig";
import { assessTarget, type TickContext } from "./assess";
import { executeBid, colorForOutcome, type BidLimits } from "./bidder";
import { writeHeartbeat, isWedged, staleAfterMs } from "./heartbeat";

/** CLI-level options controlling one sentinel run. */
export interface RunOptions {
  dryRun: boolean; // simulate only; never sends a transaction (see BidLimits.dryRun)
  once: boolean; // run a single tick and return, instead of looping
  signal: AbortSignal; // abort signal to stop the loop / in-flight sleep
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

/**
 * Runs the sentinel: validates the watchlist and (for live mode) the wallet,
 * resolves the CacheManager address, then loops polling each watch target and
 * executing bids as needed until aborted or `opts.once` completes a single
 * pass.
 *
 * Safety nets applied per tick: reconcile-drift halts bidding (live mode
 * only, unless `cfg.haltOnDrift` is off); a per-codehash cooldown prevents
 * re-acting on a target whose previous bid is still pending/propagating;
 * watch targets are periodically re-resolved so a redeploy/re-activation is
 * picked up without a restart. Assessment reads run in bounded-concurrency
 * chunks; execution (spending) is strictly serial so the per-window spend cap
 * is honored in order.
 *
 * @param opts - Run mode (dry-run/live), once-vs-loop, and an abort signal.
 * @returns Resolves when the loop stops (aborted, or after one tick if `once`).
 */
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

  // Resolve the chain before anything can sign: a bid signed for the wrong
  // chain id is rejected, so this is also what makes Nova/Orbit runs correct.
  const chain = await resolveChain();
  const cacheManager = await resolveCacheManager();
  console.log(chalk.white(`  chain: ${chain.name} (${chain.id})`));
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
    // Shared with the liveness watchdog, which derives its threshold from this
    // value so it can never fire inside a confirmation wait. See ../config.ts.
    receiptTimeoutMs: config.receiptTimeoutMs,
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
  //
  // Read from the bid_actions audit trail rather than an in-memory map, so it
  // survives a restart. That matters because the watchdog below makes restarts
  // a designed event: an in-memory cooldown would be wiped at precisely the
  // moment it is protecting a bid that is still propagating.
  const cooldownMs = cfg.bidCooldownSeconds * 1000;

  // Self-exit watchdog.
  //
  // Per-tick errors are caught below, so the loop survives a flaky RPC by
  // design. What it cannot catch is a call that never returns at all: the tick
  // body simply never completes and the loop stops making progress while the
  // process stays alive. A container restart policy reacts to a process that
  // *exits*, not to one that is merely stuck, so nothing would recover it.
  //
  // This timer runs on the event loop independently of the tick, and exits the
  // process once progress stalls past the same threshold `health` uses. Exiting
  // is what lets `restart: unless-stopped` (or systemd, or a supervisor) bring
  // it back. Skipped for --once, which has no loop to stall.
  // Progress is stamped per unit of work, not per tick. A tick containing
  // several live bids can legitimately last minutes — each bid waits up to
  // receiptTimeoutMs — and judging on whole-tick completion would let those
  // durations compound until the watchdog fired mid-bid.
  let lastProgressAtMs = Date.now();
  let lastHeartbeatWriteMs = 0;
  const markProgress = (force = false): void => {
    lastProgressAtMs = Date.now();
    // The in-memory value drives the watchdog; the file only needs to be fresh
    // enough for `health`, so throttle the writes.
    if (force || lastProgressAtMs - lastHeartbeatWriteMs >= 1_000) {
      writeHeartbeat(cfg.pollIntervalMs, lastProgressAtMs, config.receiptTimeoutMs);
      lastHeartbeatWriteMs = lastProgressAtMs;
    }
  };

  let watchdog: NodeJS.Timeout | null = null;
  if (!opts.once) {
    const limitMs = staleAfterMs(cfg.pollIntervalMs, config.receiptTimeoutMs);
    watchdog = setInterval(() => {
      if (!isWedged(lastProgressAtMs, cfg.pollIntervalMs, Date.now(), config.receiptTimeoutMs))
        return;
      const stalledFor = Math.round((Date.now() - lastProgressAtMs) / 1000);
      console.error(
        chalk.red(
          `\n  watchdog: no tick completed in ${stalledFor}s (limit ${Math.round(limitMs / 1000)}s) — ` +
            `exiting so the restart policy can recover\n`
        )
      );
      process.exit(1);
    }, Math.max(5_000, Math.floor(limitMs / 4)));
    // Do not let the watchdog alone hold the process open.
    watchdog.unref?.();
  }

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
        // A large watchlist assesses in several chunks; each completed chunk is
        // progress, so a long read phase is not mistaken for a stall either.
        markProgress();
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
        // Sourced from the persisted audit trail, so a restart mid-cooldown
        // does not forget an in-flight bid.
        const lastActionAtMs = getLastBidActionAtMs(a.target.codehash);
        if (lastActionAtMs !== null && Date.now() - lastActionAtMs < cooldownMs) {
          continue;
        }

        const result = await executeBid(a, limits);
        // A live bid can have blocked here for up to receiptTimeoutMs. Stamp
        // progress now so a slow confirmation is never mistaken for a wedge.
        markProgress();
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

    // Stamp liveness even when the tick threw. A tick that fails and is logged
    // is the loop working as designed — errors are caught per-tick on purpose.
    // What "unhealthy" must mean is that ticks stopped happening at all.
    markProgress(true);

    if (opts.once) break;

    const elapsed = Date.now() - tickStart;
    const wait = Math.max(0, cfg.pollIntervalMs - elapsed);
    await abortableSleep(wait, opts.signal);
  } while (!opts.signal.aborted);

  if (watchdog) clearInterval(watchdog);
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
