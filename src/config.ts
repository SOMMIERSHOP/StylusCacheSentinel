/**
 * Centralized static configuration, loaded once from environment variables at import time.
 *
 * All modules import `config` from here rather than reading `process.env` directly, so
 * defaults and precepts (fixed precompile address, batch/poll tuning) live in one place.
 *
 * @module
 */

import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

/** Process-wide static config, resolved once at module load from env vars (with fallback defaults). */
export const config = {
  rpcUrl: process.env.ARB_RPC_URL || "https://arb1.arbitrum.io/rpc",
  dbPath: process.env.DB_PATH || path.resolve(__dirname, "../sentinel.db"),

  // ArbWasmCache precompile lives at a fixed address on all Arbitrum chains.
  // We call allCacheManagers() on it to discover the current CacheManager.
  arbWasmCacheAddress: "0x0000000000000000000000000000000000000072" as `0x${string}`,

  // how many blocks to fetch per getLogs batch — keeps RPC calls reasonable
  batchSize: 2000,

  // poll interval in ms for the live tail after backfill finishes
  pollIntervalMs: 4000,

  // How long the bidder waits for a placeBid receipt before giving up and
  // reporting the bid as submitted-but-unconfirmed. Slow confirmations are
  // normal, which is why this is generous.
  //
  // The liveness watchdog derives its own threshold from this value (see
  // sentinel/heartbeat.ts). They must not be set independently: a watchdog
  // that fires sooner than this would kill the process during a wait the
  // bidder considers perfectly normal — with a real transaction in flight.
  receiptTimeoutMs: 120_000,
} as const;
