import { WalletList, connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet, metaMaskWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { rainbowkitBurnerWallet } from "burner-connector";
import * as chains from "viem/chains";
import scaffoldConfig from "~~/scaffold.config";

const { walletConnectProjectId } = scaffoldConfig;

// walletConnectWallet always needs a WalletConnect session, and metaMaskWallet needs one whenever the
// extension is absent; RainbowKit throws for both without a project id. With no id only injected
// wallets are offered, so the app boots with an empty environment and creates no WalletConnect connector.
const wallets = walletConnectProjectId ? [metaMaskWallet, walletConnectWallet] : [injectedWallet];

const DEV_CHAIN_IDS = new Set<number>([chains.hardhat.id, chains.foundry.id, chains.hederaTestnet.id]);

const hasDevNetwork = scaffoldConfig.targetNetworks.some(n => DEV_CHAIN_IDS.has(n.id));

export const wagmiConnectors = () => {
  if (typeof window === "undefined") {
    return [];
  }

  const walletGroups: WalletList = [
    {
      groupName: "Supported Wallets",
      wallets,
    },
  ];

  if (scaffoldConfig.enableBurnerWallet && hasDevNetwork) {
    walletGroups.push({
      groupName: "Development",
      wallets: [rainbowkitBurnerWallet],
    });
  }

  return connectorsForWallets(walletGroups, {
    appName: "scaffold-hbar",
    projectId: walletConnectProjectId,
  });
};
