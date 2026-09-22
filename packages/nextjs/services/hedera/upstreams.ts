import type { HederaNetwork } from "~~/utils/scaffold-hbar/hederaAccountId";

export class UpstreamConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamConfigError";
  }
}

/** Called on each request, so a bad value fails that request with a typed error instead of the whole route module. */
function baseUrl(variable: string, value: string | undefined, fallback: string): string {
  const url = value?.trim() || fallback;
  if (!URL.canParse(url) || !["http:", "https:"].includes(new URL(url).protocol)) {
    // The value stays out of the message: a provider URL can carry an API key.
    throw new UpstreamConfigError(`${variable} is set but is not an http(s) URL.`);
  }
  return url.replace(/\/+$/, "");
}

export function jsonRpcUrl(network: HederaNetwork): string {
  return network === "mainnet"
    ? baseUrl("HEDERA_RPC_MAINNET_URL", process.env.HEDERA_RPC_MAINNET_URL, "https://mainnet.hashio.io/api")
    : baseUrl("HEDERA_RPC_TESTNET_URL", process.env.HEDERA_RPC_TESTNET_URL, "https://testnet.hashio.io/api");
}

export function mirrorNodeUrl(network: HederaNetwork): string {
  return network === "mainnet"
    ? baseUrl(
        "HEDERA_MIRROR_MAINNET_URL",
        process.env.HEDERA_MIRROR_MAINNET_URL,
        "https://mainnet.mirrornode.hedera.com",
      )
    : baseUrl(
        "HEDERA_MIRROR_TESTNET_URL",
        process.env.HEDERA_MIRROR_TESTNET_URL,
        "https://testnet.mirrornode.hedera.com",
      );
}

export function isHederaNetwork(value: string | null): value is HederaNetwork {
  return value === "testnet" || value === "mainnet";
}
