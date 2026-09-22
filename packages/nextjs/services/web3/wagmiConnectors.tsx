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

// The connect modal is where a developer looks for the missing WalletConnect entry, so the reason is its group title.
const walletGroupName = walletConnectProjectId
  ? "Supported Wallets"
  : "Browser wallet (WalletConnect off: no project id)";

// The burner wallet builds its own RPC client; without this it would call the chain's public endpoint directly.
rainbowkitBurnerWallet.rpcUrls = scaffoldConfig.rpcOverrides;

const DEV_CHAIN_IDS = new Set<number>([chains.hardhat.id, chains.hederaTestnet.id]);

const hasDevNetwork = scaffoldConfig.targetNetworks.some(n => DEV_CHAIN_IDS.has(n.id));

export const wagmiConnectors = () => {
  if (typeof window === "undefined") {
    return [];
  }

  const walletGroups: WalletList = [
    {
      groupName: walletGroupName,
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
