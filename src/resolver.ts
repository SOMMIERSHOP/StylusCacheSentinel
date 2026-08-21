/**
 * Resolves the active Stylus CacheManager contract address.
 *
 * Arbitrum chains can register multiple CacheManagers over time via
 * ArbWasmCache; this module looks up the currently active one so the rest
 * of the indexer doesn't need a hardcoded/configured address per chain.
 *
 * @module
 */

import { getAddress } from "viem";
import { getClient } from "./provider";
import { arbWasmCacheAbi } from "./abi";
import { config } from "./config";

// grabs the active CacheManager from ArbWasmCache (last in the array)
/**
 * Looks up the currently active CacheManager address from the chain's
 * ArbWasmCache precompile/contract.
 *
 * `allCacheManagers` returns every CacheManager ever registered; by
 * convention the last entry is the active one, so that's what's returned.
 *
 * @returns checksummed address of the active CacheManager
 * @throws if ArbWasmCache reports no registered CacheManagers, which
 *   likely means Stylus caching isn't enabled on this chain
 */
export async function resolveCacheManager(): Promise<`0x${string}`> {
  const client = getClient();

  const managers = await client.readContract({
    address: config.arbWasmCacheAddress,
    abi: arbWasmCacheAbi,
    functionName: "allCacheManagers",
  });

  if (!managers || managers.length === 0) {
    throw new Error(
      "No CacheManager found via ArbWasmCache — Stylus caching might not be enabled on this chain"
    );
  }

  return getAddress(managers[managers.length - 1]) as `0x${string}`;
}
