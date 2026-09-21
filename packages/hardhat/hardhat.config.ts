import * as dotenv from "dotenv";
dotenv.config();

import { HardhatUserConfig, task } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-gas-reporter";
import "solidity-coverage";
// Only load the Hedera forking plugin when starting the local node (yarn hardhat:chain / yarn hardhat:fork).
// Deploying to an already-running node doesn't need it and would fail with EADDRINUSE.
if (process.env.HEDERA_FORKING === "true") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- conditional plugin load
  require("@hashgraph/system-contracts-forking/plugin");
}
import "hardhat-deploy";
import "hardhat-deploy-ethers";

import { HardhatPluginError } from "hardhat/plugins";

import generateTsAbis from "./scripts/generateTsAbis";
import { NO_DEPLOYER_KEY, RUNTIME_KEY_ENV } from "./utils/deployerAccount";

// Hedera JSON-RPC URL (testnet default). Set HEDERA_RPC_URL in .env for mainnet.
const hederaRpcUrl = process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api";

// Live networks sign only with a key supplied at run time: the `deploy` script decrypts
// DEPLOYER_PRIVATE_KEY_ENCRYPTED into this variable. There is deliberately no fallback:
// Hardhat's well-known account #0 is a funded account on Hedera testnet.
const deployerPrivateKey = process.env[RUNTIME_KEY_ENV];
const liveAccounts = deployerPrivateKey ? [deployerPrivateKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ],
  },
  defaultNetwork: "hardhat",
  namedAccounts: {
    deployer: {
      default: 0,
    },
  },
  networks: {
    hardhat: {
      forking: {
        url: hederaRpcUrl,
        // @ts-expect-error - custom property for hedera-forking plugin
        chainId: 296,
        workerPort: 10001,
      },
    },
    hederaTestnet: {
      url: "https://testnet.hashio.io/api",
      accounts: liveAccounts,
      chainId: 296,
    },
    hederaMainnet: {
      url: "https://mainnet.hashio.io/api",
      accounts: liveAccounts,
      chainId: 295,
    },
  },
  // Hedera is now supported on the main Sourcify instance (sourcify.dev).
  // No custom verifier URL required — standard tooling works out of the box.
  // See: https://hedera.com/blog/smart-contract-verification-sourcify-dev-now-supported
  sourcify: {
    enabled: true,
  },
  // Disable Etherscan verification (Hedera uses Sourcify only)
  etherscan: {
    enabled: false,
    apiKey: {},
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

// Extend the deploy task: refuse a network that has no signer (a direct `hardhat deploy` bypasses the
// wrapper script's own check), then generate TypeScript ABIs after deployment.
task("deploy").setAction(async (args, hre, runSuper) => {
  const { accounts } = hre.network.config;
  if (Array.isArray(accounts) && accounts.length === 0) {
    throw new HardhatPluginError("deploy", NO_DEPLOYER_KEY);
  }
  await runSuper(args);
  await generateTsAbis(hre);
});

// Extend the verify task to show HashScan link after Sourcify verification.
task("verify").setAction(async (args, hre, runSuper) => {
  await runSuper(args);

  const address = args.address;
  const chainId = hre.network.config.chainId;

  if (address && (chainId === 295 || chainId === 296)) {
    const network = chainId === 295 ? "mainnet" : "testnet";
    console.log(`\nHashScan: https://hashscan.io/${network}/contract/${address}`);
  }
});

export default config;
