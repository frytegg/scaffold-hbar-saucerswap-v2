/** The Hedera networks this project has addresses for, by the chain id their JSON-RPC relay answers. */
const NETWORK_OF_CHAIN_ID: Readonly<Record<number, string>> = { 295: "mainnet", 296: "testnet" };

export function hederaNetworkOf(chainId: number): string | undefined {
  return NETWORK_OF_CHAIN_ID[chainId];
}

/**
 * The mirror node's view of a contract: JSON, so a link checker and a script can both read it. Hashscan answers
 * HTTP 404 to everything but a browser, which is why a deployment prints this URL next to the Hashscan one.
 */
export function mirrorContractUrl(network: string, address: string): string {
  return `https://${network}.mirrornode.hedera.com/api/v1/contracts/${address}`;
}

/** The same contract rendered for a person, with its source once Sourcify has it. */
export function hashscanContractUrl(network: string, address: string): string {
  return `https://hashscan.io/${network}/contract/${address}`;
}
