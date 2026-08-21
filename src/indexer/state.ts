/**
 * Live on-chain reader for CacheManager configuration/state.
 *
 * Fetches the current cache size, queue size, decay rate, and pause state
 * directly from the contract via RPC. Used by `reconcile` as the source of
 * truth to check the DB-derived state against.
 *
 * @module
 */

import { getClient } from "../provider";
import { cacheManagerAbi } from "../abi";
import type { CacheState } from "../types";

// fetch cache state in parallel
/**
 * Reads the CacheManager's current `cacheSize`, `queueSize`, `decay`, and
 * `isPaused` values directly from the chain, in parallel.
 *
 * @param cacheManagerAddr - address of the CacheManager contract to read from
 * @returns the live on-chain cache state
 */
export async function readCacheState(
  cacheManagerAddr: `0x${string}`
): Promise<CacheState> {
  const client = getClient();

  const [cacheSize, queueSize, decayRate, paused] = await Promise.all([
    client.readContract({
      address: cacheManagerAddr,
      abi: cacheManagerAbi,
      functionName: "cacheSize",
    }),
    client.readContract({
      address: cacheManagerAddr,
      abi: cacheManagerAbi,
      functionName: "queueSize",
    }),
    client.readContract({
      address: cacheManagerAddr,
      abi: cacheManagerAbi,
      functionName: "decay",
    }),
    client.readContract({
      address: cacheManagerAddr,
      abi: cacheManagerAbi,
      functionName: "isPaused",
    }),
  ]);

  return {
    cacheSize: cacheSize as bigint,
    queueSize: queueSize as bigint,
    decay: decayRate as bigint,
    isPaused: paused as boolean,
    cacheManagerAddress: cacheManagerAddr,
  };
}
