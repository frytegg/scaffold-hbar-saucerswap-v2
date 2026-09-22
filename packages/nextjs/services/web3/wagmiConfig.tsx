import { wagmiConnectors } from "./wagmiConnectors";
import { createClient, http } from "viem";
import { createConfig } from "wagmi";
import scaffoldConfig, { ScaffoldConfig } from "~~/scaffold.config";

const { targetNetworks } = scaffoldConfig;

export const enabledChains = targetNetworks;

export const wagmiConfig = createConfig({
  chains: enabledChains,
  connectors: wagmiConnectors(),
  ssr: true,
  client({ chain }) {
    // No fallback to the chain's public endpoint: it would route around the relay the moment the relay
    // reports an upstream failure. A chain without an override (the local fork) uses its own default URL.
    const rpcOverrideUrl = (scaffoldConfig.rpcOverrides as ScaffoldConfig["rpcOverrides"])?.[chain.id];

    return createClient({
      chain,
      transport: http(rpcOverrideUrl),
      pollingInterval: scaffoldConfig.pollingInterval,
    });
  },
});
