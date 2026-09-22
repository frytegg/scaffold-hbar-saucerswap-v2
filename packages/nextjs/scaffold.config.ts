import * as chains from "viem/chains";

export type ScaffoldConfig = {
  targetNetworks: readonly [chains.Chain, ...chains.Chain[]];
  pollingInterval: number;
  rpcOverrides?: Record<number, string>;
  enableBurnerWallet: boolean;
  walletConnectProjectId: string;
};

const hederaLocalFork = {
  ...chains.hardhat,
  name: "Hedera Local Fork",
  nativeCurrency: {
    name: "HBAR",
    symbol: "HBAR",
    // HBAR has 8 decimals (tinybar), and a contract on Hedera reads msg.value in tinybar. A transaction's
    // value and gas price use 18 (weibar, 10^10 per tinybar) over JSON-RPC, which is what viem and Hardhat format.
    decimals: 18,
  },
} as const satisfies chains.Chain;

const targetNetworks = [chains.hederaTestnet, chains.hedera, hederaLocalFork] as const satisfies readonly [
  chains.Chain,
  ...chains.Chain[],
];

const scaffoldConfig = {
  targetNetworks,

  pollingInterval: 10000,

  enableBurnerWallet: true,

  // The browser reaches Hedera JSON-RPC through the app's own relay (app/api/hedera/rpc), never directly;
  // services/hedera/jsonRpcRelay.ts says why. The relay's upstream is set on the server: HEDERA_RPC_TESTNET_URL,
  // HEDERA_RPC_MAINNET_URL.
  rpcOverrides: {
    [chains.hedera.id]: "/api/hedera/rpc?network=mainnet",
    [chains.hederaTestnet.id]: "/api/hedera/rpc?network=testnet",
  },

  // Empty means WalletConnect is off: only wallets that need no relay are offered (see wagmiConnectors.tsx).
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID ?? "",
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
