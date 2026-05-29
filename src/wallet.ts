import {
  createWalletClient,
  http,
  formatEther,
  type WalletClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { getClient, getRpcUrl } from "./provider";

// Signing is driven by the SENTINEL_PRIVATE_KEY env var (chosen wallet model).
// We never persist it; it is read once and turned into a viem Account.
const RAW_KEY = process.env.SENTINEL_PRIVATE_KEY;

let _account: Account | null = null;
let _wallet: WalletClient | null = null;
// RPC the cached wallet client was built against; lets us rebuild if the RPC
// override changes after the client already exists (provider.setRpcUrl resets
// the public client but can't reach in here without an import cycle).
let _walletRpc: string | null = null;

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

export function getWalletClient(): WalletClient {
  const rpc = getRpcUrl();
  if (!_wallet || _walletRpc !== rpc) {
    _wallet = createWalletClient({
      account: getAccount(),
      chain: arbitrum,
      transport: http(rpc),
    });
    _walletRpc = rpc;
  }
  return _wallet;
}

export async function getBalanceWei(): Promise<bigint> {
  const account = getAccount();
  return getClient().getBalance({ address: account.address });
}

export async function describeWallet(): Promise<{
  address: `0x${string}`;
  balanceWei: bigint;
  balanceEth: string;
}> {
  const address = getAccount().address;
  const balanceWei = await getBalanceWei();
  return { address, balanceWei, balanceEth: formatEther(balanceWei) };
}
