import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

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
} as const;
