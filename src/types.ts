export interface CacheState {
  cacheSize: bigint;
  queueSize: bigint;
  decay: bigint;
  isPaused: boolean;
  cacheManagerAddress: string;
}
