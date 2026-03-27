import { createPublicClient, http, type PublicClient } from "viem";
import { arbitrum } from "viem/chains";
import { config } from "./config";

let _client: PublicClient | null = null;

export function getClient(): PublicClient {
  if (!_client) {
    _client = createPublicClient({
      chain: arbitrum,
      transport: http(config.rpcUrl),
    });
  }
  return _client;
}
