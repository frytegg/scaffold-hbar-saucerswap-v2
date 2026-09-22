import * as dotenv from "dotenv";
dotenv.config();
import { ENCRYPTED_KEY_ENV, NO_ENCRYPTED_ACCOUNT } from "../utils/deployerAccount";
import { decryptDeployerKey } from "../utils/deployerKey";

async function main() {
  const encryptedKey = process.env[ENCRYPTED_KEY_ENV];

  if (!encryptedKey) {
    throw new Error(NO_ENCRYPTED_ACCOUNT);
  }

  console.log("👀 This will reveal your private key on the console.\n");

  const wallet = await decryptDeployerKey(encryptedKey);
  console.log("\n🔑 Private key:", wallet.privateKey);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
