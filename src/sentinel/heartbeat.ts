/**
 * Liveness signal for the sentinel loop.
 *
 * A restart policy only reacts to a process that *exits*. The failure mode that
 * actually matters here is different: a loop still running but no longer making
 * progress — wedged on an unresponsive RPC, or stuck in a call with no timeout.
 * To an orchestrator that container looks perfectly healthy forever.
 *
 * So the loop stamps a file at the end of every tick, and {@link checkHealth}
 * asks one question: was the last tick recent enough? The check reads only the
 * local filesystem — deliberately no RPC and no database — because a health
 * probe that depends on the chain would report unhealthy during the exact
 * network trouble the loop is designed to ride out.
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";
import { sentinelHome } from "../cli/userConfig";
import { config } from "../config";

/** Contents of the heartbeat file: when the loop last made progress, and the limits it is running under. */
export interface Heartbeat {
  /** Unix milliseconds at which the loop last completed a unit of work. */
  tickCompletedAtMs: number;
  /** The loop's configured poll interval, used to derive how long is "too long". */
  pollIntervalMs: number;
  /**
   * The receipt timeout the loop was running with. Recorded so the health
   * check judges liveness by the same limits the loop actually applied, rather
   * than by whatever the defaults happen to be when the check runs.
   * Optional for heartbeats written before this field existed.
   */
  receiptTimeoutMs?: number;
}

/** Verdict from {@link checkHealth}, plus the numbers behind it for logging. */
export interface HealthReport {
  ok: boolean;
  /** Time since the last recorded tick, or null when no heartbeat exists yet. */
  ageMs: number | null;
  /** Age at which the loop is considered wedged. */
  staleAfterMs: number;
  reason: string;
}

// Never call a loop wedged just because it polls slowly. A tick can legitimately
// overrun its interval — a big watchlist, a slow RPC round-trip — so allow
// several intervals.
const MISSED_TICKS_BEFORE_STALE = 3;

// ...and never less than the longest single blocking operation the loop is
// designed to perform, with margin. That operation is waiting for a placeBid
// receipt, which the bidder allows `receiptTimeoutMs` for.
//
// This floor is DERIVED, not chosen. A hardcoded floor below the receipt
// timeout would let the watchdog kill the process mid-bid: the transaction is
// already on-chain, the bid_actions row is stuck at `submitted`, and the
// restarted loop may re-bid a target whose first bid is still propagating.
// Deriving it keeps a single threshold that cannot drift out of step with the
// bidder's own patience.
const RECEIPT_TIMEOUT_SAFETY_FACTOR = 1.5;

/**
 * Path of the heartbeat file, inside the sentinel home directory so it lands on
 * the same persisted volume as the config in a container deployment.
 *
 * @returns absolute path to the heartbeat file
 */
export function heartbeatPath(): string {
  return path.join(sentinelHome(), "heartbeat.json");
}

/**
 * How long without progress counts as wedged.
 *
 * The result is always at least `receiptTimeoutMs × 1.5`, so the watchdog can
 * never fire inside a confirmation wait the bidder itself is willing to make.
 *
 * @param pollIntervalMs - the loop's configured tick interval
 * @param receiptTimeoutMs - the bidder's confirmation timeout; defaults to the project setting
 * @returns the staleness threshold in milliseconds
 */
export function staleAfterMs(
  pollIntervalMs: number,
  receiptTimeoutMs: number = config.receiptTimeoutMs
): number {
  return Math.max(
    pollIntervalMs * MISSED_TICKS_BEFORE_STALE,
    Math.ceil(receiptTimeoutMs * RECEIPT_TIMEOUT_SAFETY_FACTOR)
  );
}

/**
 * Whether a loop that last made progress at `lastProgressAtMs` should now be
 * considered wedged.
 *
 * Same threshold as {@link checkHealth}, but phrased for the in-process
 * watchdog, which knows when its own last tick was and does not need to read
 * the file back.
 *
 * @param lastProgressAtMs - unix ms of the last completed tick
 * @param pollIntervalMs - the loop's configured tick interval
 * @param nowMs - current time; injectable for tests
 * @returns true when the loop has gone too long without completing a tick
 */
export function isWedged(
  lastProgressAtMs: number,
  pollIntervalMs: number,
  nowMs = Date.now(),
  receiptTimeoutMs: number = config.receiptTimeoutMs
): boolean {
  return nowMs - lastProgressAtMs > staleAfterMs(pollIntervalMs, receiptTimeoutMs);
}

/**
 * Record that a tick just completed. Called by the loop, once per tick.
 *
 * Never throws: a heartbeat write failing (read-only mount, full disk) must not
 * take down an otherwise healthy bidding loop. A missed write simply ages the
 * heartbeat, which the health check will report on its own.
 *
 * @param pollIntervalMs - the loop's configured tick interval, stamped alongside the timestamp
 * @param nowMs - current time; injectable for tests
 * @param receiptTimeoutMs - the bidder's confirmation timeout in force, recorded so the
 *   health check applies the same threshold the loop was running under
 */
export function writeHeartbeat(
  pollIntervalMs: number,
  nowMs = Date.now(),
  receiptTimeoutMs: number = config.receiptTimeoutMs
): void {
  const beat: Heartbeat = {
    tickCompletedAtMs: nowMs,
    pollIntervalMs,
    receiptTimeoutMs,
  };
  try {
    fs.mkdirSync(sentinelHome(), { recursive: true });
    fs.writeFileSync(heartbeatPath(), JSON.stringify(beat) + "\n");
  } catch {
    /* deliberately ignored — see above */
  }
}

/**
 * Read the last recorded heartbeat.
 *
 * @returns the heartbeat, or null if absent or unreadable/corrupt
 */
export function readHeartbeat(): Heartbeat | null {
  try {
    const raw = JSON.parse(fs.readFileSync(heartbeatPath(), "utf8"));
    if (
      typeof raw?.tickCompletedAtMs === "number" &&
      typeof raw?.pollIntervalMs === "number"
    ) {
      return raw as Heartbeat;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decide whether the loop is still making progress, from the heartbeat alone.
 *
 * Pure with respect to time — pass `nowMs` — so the staleness boundary is
 * unit-testable without waiting on a clock.
 *
 * @param beat - the heartbeat to judge, or null when none exists
 * @param nowMs - current time in unix milliseconds
 * @returns the verdict, the measured age, and the threshold applied
 */
export function checkHealth(beat: Heartbeat | null, nowMs = Date.now()): HealthReport {
  if (!beat) {
    return {
      ok: false,
      ageMs: null,
      staleAfterMs: staleAfterMs(config.pollIntervalMs),
      reason:
        "no heartbeat recorded — the sentinel loop has not completed a tick (is `run` the container's command?)",
    };
  }

  // Judge by the limits the loop recorded, not by today's defaults.
  const limit = staleAfterMs(beat.pollIntervalMs, beat.receiptTimeoutMs);
  const age = nowMs - beat.tickCompletedAtMs;

  // A heartbeat from the future means the clock moved backwards. Treat it as
  // present rather than as wildly stale, and say so.
  if (age < 0) {
    return {
      ok: true,
      ageMs: age,
      staleAfterMs: limit,
      reason: "heartbeat is dated in the future — clock skew, treating as live",
    };
  }

  if (age > limit) {
    return {
      ok: false,
      ageMs: age,
      staleAfterMs: limit,
      reason: `last tick was ${Math.round(age / 1000)}s ago, over the ${Math.round(limit / 1000)}s limit — the loop is not progressing`,
    };
  }

  return {
    ok: true,
    ageMs: age,
    staleAfterMs: limit,
    reason: `last tick ${Math.round(age / 1000)}s ago, within the ${Math.round(limit / 1000)}s limit`,
  };
}
