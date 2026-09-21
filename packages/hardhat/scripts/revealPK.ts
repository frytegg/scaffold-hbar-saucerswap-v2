import * as dotenv from "dotenv";
dotenv.config();
import { Wallet } from "ethers";
import password from "@inquirer/password";
import { ENCRYPTED_KEY_ENV, NO_ENCRYPTED_ACCOUNT } from "../utils/deployerAccount";

async function main() {
  const encryptedKey = process.env[ENCRYPTED_KEY_ENV];

  if (!encryptedKey) {
    throw new Error(NO_ENCRYPTED_ACCOUNT);
  }

  console.log("👀 This will reveal your private key on the console.\n");

  const pass = await password({ message: "Enter your password to decrypt the private key:" });
  let wallet: Wallet;
  try {
    wallet = (await Wallet.fromEncryptedJson(encryptedKey, pass)) as Wallet;
  } catch {
    console.log("❌ Failed to decrypt private key. Wrong password?");
    return;
  }

  console.log("\n🔑 Private key:", wallet.privateKey);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
