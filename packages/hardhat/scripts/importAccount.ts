import { Wallet } from "ethers";
import password from "@inquirer/password";
import { storeDeployerKey } from "../utils/deployerKey";

async function askPrivateKey(): Promise<Wallet> {
  while (true) {
    const privateKey = await password({ message: "Paste your private key:" });
    try {
      return new Wallet(privateKey);
    } catch {
      console.log("❌ Invalid private key format. Please try again.");
    }
  }
}

async function main() {
  const address = await storeDeployerKey(async () => {
    console.log("👛 Importing Wallet\n");
    return askPrivateKey();
  });

  console.log("\n📄 Encrypted Private Key saved to packages/hardhat/.env file");
  console.log("🪄 Imported wallet address:", address, "\n");
  console.log("⚠️ Make sure to remember your password! You'll need it to decrypt the private key.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
