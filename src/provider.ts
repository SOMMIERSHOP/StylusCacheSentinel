import { createPublicClient, http, type PublicClient } from "viem";
import { arbitrum } from "viem/chains";
import { config } from "./config";

let _client: PublicClient | null = null;
// Optional override applied from the user config (config set rpcUrl ...) before
// any client is built. Takes precedence over the env/default in config.rpcUrl.
let _rpcOverride: string | null = null;
// Whether to batch contract reads via Multicall3. Off by default and only
// turned on once we've confirmed Multicall3 exists on the connected chain
// (see detectAndEnableMulticall) — so chains without it (some Orbit chains)
// safely fall back to non-batched reads instead of every read reverting.
let _multicall = false;

// Set the RPC URL the clients should use. The CLI calls this in main() before
// any client is created. Resets the cached public client so a later override
// still takes effect; the wallet client self-heals via getRpcUrl() in wallet.ts.
export function setRpcUrl(url: string): void {
  _rpcOverride = url;
  _client = null;
}

export function getRpcUrl(): string {
  return _rpcOverride ?? config.rpcUrl;
}

// Enable/disable Multicall3 read batching. Resets the cached client so the
// change takes effect on next use.
export function setMulticall(on: boolean): void {
  if (_multicall !== on) {
    _multicall = on;
    _client = null;
  }
}

// Detect whether Multicall3 is deployed on the connected chain and enable
// batching if so. Returns the resulting state. Safe on Orbit chains: if the
// contract isn't present (or the probe fails) we leave batching off and the
// caller falls back to chunked concurrent reads.
export async function detectAndEnableMulticall(): Promise<boolean> {
  const mc = arbitrum.contracts?.multicall3?.address;
  if (!mc) return false;
  try {
    const code = await getClient().getCode({ address: mc });
    const ok = !!code && code !== "0x";
    setMulticall(ok);
    return ok;
  } catch {
    return false;
  }
}

export function getClient(): PublicClient {
  if (!_client) {
    _client = createPublicClient({
      chain: arbitrum,
      transport: http(getRpcUrl()),
      ...(_multicall ? { batch: { multicall: true } } : {}),
    });
  }
  return _client;
}
