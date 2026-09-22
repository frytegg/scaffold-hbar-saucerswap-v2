import { Wallet } from "ethers";
import { storeDeployerKey } from "../utils/deployerKey";

async function main() {
  const address = await storeDeployerKey(async () => {
    console.log("👛 Generating new Wallet\n");
    return Wallet.createRandom();
  });

  console.log("\n📄 Encrypted Private Key saved to packages/hardhat/.env file");
  console.log("🪄 Generated wallet address:", address, "\n");
  console.log("⚠️ Make sure to remember your password! You'll need it to decrypt the private key.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
