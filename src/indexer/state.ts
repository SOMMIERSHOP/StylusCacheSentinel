import { getClient } from "../provider";
import { cacheManagerAbi } from "../abi";
import type { CacheState } from "../types";

// fetch cache state in parallel
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
