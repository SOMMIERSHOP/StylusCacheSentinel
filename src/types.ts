/**
 * Shared cross-module type definitions.
 *
 * Currently holds the on-chain CacheManager snapshot shape returned by
 * `readCacheState` and consumed by the indexer, reconciler, and sentinel.
 *
 * @module
 */

/** Live snapshot of ArbWasmCache/CacheManager state read directly from the chain (not from the local DB). */
export interface CacheState {
  /** Total bytes currently occupied in the cache. */
  cacheSize: bigint;
  /** Bytes queued for eviction/insertion, per the CacheManager's internal accounting. */
  queueSize: bigint;
  /** Current decay rate parameter governing eviction priority. */
  decay: bigint;
  isPaused: boolean;
  /** Address of the CacheManager contract this snapshot was read from. */
  cacheManagerAddress: string;
}
