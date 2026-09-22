export type HederaNetwork = "testnet" | "mainnet";

export type AccountLookupErrorCode = "invalid_address" | "invalid_network" | "misconfigured" | "mirror_unavailable";

/**
 * Body of GET /api/hedera/account. The route answers HTTP 200 in every case, as the JSON-RPC relay does
 * (services/hedera/jsonRpcRelay.ts says why); success and failure are told apart by `ok`. `accountId` is
 * null for an address the network has not seen yet.
 */
export type AccountLookupResponse =
  | { ok: true; accountId: string | null }
  | { ok: false; error: { code: AccountLookupErrorCode; message: string } };

const CHAIN_ID_TO_NETWORK: Record<number, HederaNetwork> = {
  295: "mainnet",
  296: "testnet",
};

/** Maps a viem/wagmi chain ID to "testnet" | "mainnet". Defaults to "testnet". */
export function chainIdToHederaNetwork(chainId: number): HederaNetwork {
  return CHAIN_ID_TO_NETWORK[chainId] ?? "testnet";
}

/**
 * Looks up the Hedera account ID (e.g. "0.0.8041897") of an EVM address through the app's own route.
 * Never throws: a request that cannot complete comes back as the same `ok: false` shape the route uses.
 */
export async function lookupHederaAccountId(
  evmAddress: string,
  network: HederaNetwork = "testnet",
): Promise<AccountLookupResponse> {
  const params = new URLSearchParams({ evm: evmAddress, network });

  try {
    const response = await fetch(`/api/hedera/account?${params}`);
    return (await response.json()) as AccountLookupResponse;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: "mirror_unavailable", message: `Account lookup failed: ${reason}` } };
  }
}
