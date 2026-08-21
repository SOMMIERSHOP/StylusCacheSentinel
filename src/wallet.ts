/**
 * Env-only signing wallet for the sentinel automation layer.
 *
 * The private key is read exclusively from SENTINEL_PRIVATE_KEY and is never
 * written to disk or otherwise persisted — it lives only in process memory for
 * the lifetime of this module. Callers that need to sign (manual `bid`, the
 * `run` automation loop) must have the env var set; read-only commands do not.
 *
 * @module
 */

import {
  createWalletClient,
  http,
  formatEther,
  type WalletClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getClient, getRpcUrl, resolveChain } from "./provider";

// Signing is driven by the SENTINEL_PRIVATE_KEY env var (chosen wallet model).
// We never persist it; it is read once and turned into a viem Account.
const RAW_KEY = process.env.SENTINEL_PRIVATE_KEY;

let _account: Account | null = null;
let _wallet: WalletClient | null = null;
// RPC the cached wallet client was built against; lets us rebuild if the RPC
// override changes after the client already exists (provider.setRpcUrl resets
// the public client but can't reach in here without an import cycle).
let _walletRpc: string | null = null;

/**
 * Whether SENTINEL_PRIVATE_KEY is set, i.e. signing is available.
 *
 * Does not validate the key's format — use {@link getAccount} for that.
 *
 * @returns true if a (possibly invalid) private key is present in the env
 */
export function hasWallet(): boolean {
  return typeof RAW_KEY === "string" && RAW_KEY.length > 0;
}

function normalizeKey(raw: string): `0x${string}` {
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "SENTINEL_PRIVATE_KEY must be a 32-byte hex private key (64 hex chars, optional 0x prefix)"
    );
  }
  return hex as `0x${string}`;
}

/**
 * Get (and lazily construct/cache) the signing account derived from
 * SENTINEL_PRIVATE_KEY.
 *
 * @returns the viem {@link Account} for the configured private key
 * @throws if SENTINEL_PRIVATE_KEY is unset or is not a valid 32-byte hex key
 */
export function getAccount(): Account {
  if (!RAW_KEY) {
    throw new Error(
      "No wallet configured. Set SENTINEL_PRIVATE_KEY in your environment (or .env) to enable signing."
    );
  }
  if (!_account) {
    _account = privateKeyToAccount(normalizeKey(RAW_KEY));
  }
  return _account;
}

/**
 * Get (and lazily construct/cache) a viem {@link WalletClient} bound to the
 * signing account, the current RPC endpoint, and the chain that endpoint
 * actually serves. Rebuilds automatically if the RPC URL changes (e.g. via
 * `config set rpcUrl`) after the client was built.
 *
 * Async because the chain is discovered from the RPC rather than hardcoded —
 * signing for the wrong chain id would have every transaction rejected, so the
 * chain must be known before a client exists to sign with.
 *
 * @returns a wallet client ready to sign and submit transactions on the connected chain
 * @throws if SENTINEL_PRIVATE_KEY is unset or invalid (via {@link getAccount})
 */
export async function getWalletClient(): Promise<WalletClient> {
  const rpc = getRpcUrl();
  if (!_wallet || _walletRpc !== rpc) {
    _wallet = createWalletClient({
      account: getAccount(),
      chain: await resolveChain(),
      transport: http(rpc),
    });
    _walletRpc = rpc;
  }
  return _wallet;
}

/**
 * Fetch the signer's current ETH balance from chain.
 *
 * @returns balance in wei
 * @throws if SENTINEL_PRIVATE_KEY is unset or invalid
 */
export async function getBalanceWei(): Promise<bigint> {
  const account = getAccount();
  return getClient().getBalance({ address: account.address });
}

/**
 * Convenience summary of the signer for CLI display (`wallet balance`).
 *
 * @returns the signer address plus its balance in both wei and formatted ETH
 * @throws if SENTINEL_PRIVATE_KEY is unset or invalid
 */
export async function describeWallet(): Promise<{
  address: `0x${string}`;
  balanceWei: bigint;
  balanceEth: string;
}> {
  const address = getAccount().address;
  const balanceWei = await getBalanceWei();
  return { address, balanceWei, balanceEth: formatEther(balanceWei) };
}
