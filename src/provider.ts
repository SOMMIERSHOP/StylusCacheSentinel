/**
 * Builds and caches the viem clients' chain identity and the PublicClient used
 * for all read-only RPC calls.
 *
 * The chain is **discovered from the RPC**, not hardcoded. Sentinel is meant to
 * run against Arbitrum One, Nova, and arbitrary Orbit chains, and a transaction
 * signed for the wrong chain id is rejected outright — so the chain must follow
 * whatever `rpcUrl` points at. A known Arbitrum-family chain id resolves to
 * viem's own definition; anything else is synthesized from the chain id itself.
 *
 * Both the chain and the client are lazily-created singletons, invalidated
 * whenever the RPC URL or the multicall setting changes.
 *
 * @module
 */
import {
  createPublicClient,
  defineChain,
  http,
  type Chain,
  type PublicClient,
} from "viem";
import { arbitrum, arbitrumNova, arbitrumSepolia } from "viem/chains";
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
// Resolved chain identity, plus the RPC it was resolved against so a later
// setRpcUrl() invalidates it. `_chainPromise` dedupes concurrent resolutions.
let _chain: Chain | null = null;
let _chainRpc: string | null = null;
let _chainPromise: Promise<Chain> | null = null;

// Arbitrum-family chains viem already describes properly. Anything outside this
// list is treated as an Orbit chain and synthesized (see resolveChain).
const KNOWN_CHAINS: readonly Chain[] = [arbitrum, arbitrumNova, arbitrumSepolia];

// Multicall3 is deployed at the same deterministic address on most chains.
// Used only as a probe target for chains viem has no definition for; the probe
// in detectAndEnableMulticall still checks that code actually lives there.
const CANONICAL_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

// Set the RPC URL the clients should use. The CLI calls this in main() before
// any client is created. Resets the cached public client and chain so a later
// override still takes effect; the wallet client self-heals via getRpcUrl().
/**
 * Overrides the RPC URL used by all clients, taking precedence over
 * `config.rpcUrl`. Invalidates the cached public client and the resolved chain,
 * so the next getClient() / resolveChain() call re-derives both.
 *
 * @param url - The RPC URL to use going forward.
 */
export function setRpcUrl(url: string): void {
  _rpcOverride = url;
  _client = null;
  _chain = null;
  _chainRpc = null;
  _chainPromise = null;
}

/**
 * @returns The effective RPC URL: the override set via setRpcUrl(), or config.rpcUrl.
 */
export function getRpcUrl(): string {
  return _rpcOverride ?? config.rpcUrl;
}

/**
 * Map a chain id to a viem {@link Chain}, synthesizing one for chains viem does
 * not describe.
 *
 * Pure — no network, no cache — so the Orbit-chain branch is unit-testable
 * without an Orbit RPC to point at.
 *
 * @param id - chain id reported by the RPC endpoint
 * @param rpcUrl - endpoint to record on a synthesized chain
 * @returns viem's own definition for a known Arbitrum-family id, otherwise a
 *   minimal chain carrying that id, 18-decimal ETH, and `rpcUrl`
 */
export function chainForId(id: number, rpcUrl: string): Chain {
  const known = KNOWN_CHAINS.find((c) => c.id === id);
  if (known) return known;
  return defineChain({
    id,
    name: `Orbit chain ${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: CANONICAL_MULTICALL3 } },
  });
}

/**
 * Resolve the chain the configured RPC actually serves, by asking it for its
 * chain id.
 *
 * A chain id viem already knows (Arbitrum One, Nova, Sepolia) resolves to
 * viem's definition. Any other id — an Orbit chain — is synthesized into a
 * minimal {@link Chain} carrying that id, 18-decimal ETH, and the configured
 * RPC. This is what lets `placeBid` be signed for the right chain: a
 * transaction built for chain 42161 is rejected by any other chain.
 *
 * Cached per RPC URL, and invalidated by {@link setRpcUrl}. Concurrent callers
 * share a single in-flight probe.
 *
 * @returns The chain served by the current RPC endpoint.
 */
export async function resolveChain(): Promise<Chain> {
  const rpc = getRpcUrl();
  if (_chain && _chainRpc === rpc) return _chain;
  if (_chainPromise && _chainRpc === rpc) return _chainPromise;

  _chainRpc = rpc;
  _chainPromise = (async () => {
    // Probe with a chain-less client: reads don't need a chain, which is
    // exactly how we break the "need a chain to learn the chain" cycle.
    const probe = createPublicClient({ transport: http(rpc) });
    const id = await probe.getChainId();
    const chain = chainForId(id, rpc);

    _chain = chain;
    // Rebuild the public client so it carries the resolved chain (needed for
    // multicall batching, which reads chain.contracts.multicall3).
    _client = null;
    return chain;
  })();

  return _chainPromise;
}

/**
 * The already-resolved chain, if {@link resolveChain} has completed.
 *
 * @returns The cached chain, or null if it has not been resolved yet.
 */
export function getChain(): Chain | null {
  return _chain && _chainRpc === getRpcUrl() ? _chain : null;
}

// Enable/disable Multicall3 read batching. Resets the cached client so the
// change takes effect on next use.
/**
 * Enables or disables Multicall3 read batching. Invalidates the cached
 * public client so the change takes effect on the next getClient() call.
 * No-op if the requested state already matches.
 *
 * @param on - Whether to batch reads via Multicall3.
 */
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
/**
 * Probes whether Multicall3 is deployed on the connected chain and, if so,
 * enables read batching via {@link setMulticall}. Resolves the chain first, so
 * the probe targets that chain's own Multicall3 address where viem knows it,
 * and the canonical deterministic address otherwise. Fails safe: on chains
 * without Multicall3 (e.g. some Orbit chains) or if the probe itself errors,
 * batching is left off rather than causing every subsequent read to revert.
 *
 * @returns Whether batching ended up enabled.
 */
export async function detectAndEnableMulticall(): Promise<boolean> {
  try {
    const chain = await resolveChain();
    const mc = chain.contracts?.multicall3?.address ?? CANONICAL_MULTICALL3;
    const code = await getClient().getCode({ address: mc });
    const ok = !!code && code !== "0x";
    setMulticall(ok);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Returns the lazily-created, cached viem PublicClient, built with the current
 * RPC URL, the resolved chain (once known), and the multicall setting. Rebuilt
 * automatically whenever setRpcUrl(), setMulticall(), or resolveChain()
 * invalidates the cache.
 *
 * Safe to call before the chain has been resolved: read-only calls do not
 * require a chain, and the client is rebuilt with it once available.
 *
 * @returns The shared PublicClient instance.
 */
export function getClient(): PublicClient {
  if (!_client) {
    const chain = getChain();
    _client = createPublicClient({
      ...(chain ? { chain } : {}),
      transport: http(getRpcUrl()),
      ...(_multicall ? { batch: { multicall: true } } : {}),
    });
  }
  return _client;
}
