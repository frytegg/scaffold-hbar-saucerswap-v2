import * as dotenv from "dotenv";
dotenv.config();

import { HardhatUserConfig, task } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@typechain/hardhat";
import "hardhat-gas-reporter";
import "solidity-coverage";
// Only load the Hedera forking plugin where a script sets HEDERA_FORKING (`chain` and `test`).
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

// Endpoint the in-process `hardhat` network forks (the `chain` and `test` scripts, and a deploy without --network).
// The live networks below keep their own URLs.
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

export default config;
