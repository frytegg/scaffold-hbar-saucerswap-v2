import * as dotenv from "dotenv";
dotenv.config();
import { ethers } from "ethers";
import QRCode from "qrcode";
import { config } from "hardhat";
import { ENCRYPTED_KEY_ENV, LOCAL_NETWORKS, NO_ENCRYPTED_ACCOUNT } from "../utils/deployerAccount";
import { decryptDeployerKey } from "../utils/deployerKey";

async function main() {
  const encryptedKey = process.env[ENCRYPTED_KEY_ENV];

  if (!encryptedKey) {
    throw new Error(NO_ENCRYPTED_ACCOUNT);
  }

  const { address } = await decryptDeployerKey(encryptedKey);
  console.log(await QRCode.toString(address, { type: "terminal", small: true }));
  console.log("Public address:", address, "\n");

  const unreachable: string[] = [];
  for (const [networkName, network] of Object.entries(config.networks)) {
    if (LOCAL_NETWORKS.has(networkName) || !("url" in network)) continue;
    try {
      const provider = new ethers.JsonRpcProvider(network.url);
      await provider._detectNetwork();
      const balance = await provider.getBalance(address);
      console.log("--", networkName, "-- 📡");
      console.log("   balance:", +ethers.formatEther(balance));
      console.log("   nonce:", +(await provider.getTransactionCount(address)));
    } catch (error: unknown) {
      console.error(`Can't read ${networkName} at ${network.url}: ${error instanceof Error ? error.message : error}`);
      unreachable.push(networkName);
    }
  }
  if (unreachable.length > 0) {
    throw new Error(`Could not read the account on ${unreachable.join(", ")}: see above.`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
