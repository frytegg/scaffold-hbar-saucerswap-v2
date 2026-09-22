import * as dotenv from "dotenv";
dotenv.config();
import { spawn } from "child_process";
import { config } from "hardhat";
import { ENCRYPTED_KEY_ENV, LOCAL_NETWORKS, NO_DEPLOYER_KEY, RUNTIME_KEY_ENV } from "../utils/deployerAccount";
import { decryptDeployerKey } from "../utils/deployerKey";

// Running Hardhat's CLI entry with the current Node binary needs no shell on any platform,
// so user-supplied arguments are never concatenated into a command line.
const HARDHAT_CLI = require.resolve("hardhat/internal/cli/bootstrap");

function runHardhatDeploy(): void {
  const hardhat = spawn(process.execPath, [HARDHAT_CLI, "deploy", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });

  hardhat.on("error", error => {
    console.error(`Could not start hardhat: ${error.message}`);
    process.exit(1);
  });
  // A null code means the child was killed by a signal: that is not a successful deploy.
  hardhat.on("exit", code => process.exit(code ?? 1));
}

/**
 * Local networks deploy with Hardhat's own accounts. Live networks need a key:
 * one already present in the environment, or the encrypted one after a password prompt.
 */
async function main(): Promise<void> {
  const networkIndex = process.argv.indexOf("--network");
  const networkName = networkIndex !== -1 ? process.argv[networkIndex + 1] : config.defaultNetwork;

  if (!LOCAL_NETWORKS.has(networkName) && !process.env[RUNTIME_KEY_ENV]) {
    const encryptedKey = process.env[ENCRYPTED_KEY_ENV];
    if (!encryptedKey) {
      throw new Error(NO_DEPLOYER_KEY);
    }
    process.env[RUNTIME_KEY_ENV] = (await decryptDeployerKey(encryptedKey)).privateKey;
  }

  runHardhatDeploy();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
