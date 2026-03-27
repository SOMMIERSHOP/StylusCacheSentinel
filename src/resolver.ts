import { getAddress } from "viem";
import { getClient } from "./provider";
import { arbWasmCacheAbi } from "./abi";
import { config } from "./config";

// grabs the active CacheManager from ArbWasmCache (last in the array)
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
