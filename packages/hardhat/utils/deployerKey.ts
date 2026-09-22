import password from "@inquirer/password";
import { HDNodeWallet, Wallet } from "ethers";
import { ENCRYPTED_KEY_ENV } from "./deployerAccount";

/** Asks for the password of the stored deployer key and decrypts it. A wrong password throws. */
export async function decryptDeployerKey(encryptedKey: string): Promise<Wallet | HDNodeWallet> {
  const pass = await password({ message: "Enter the password of the deployer key:" });
  try {
    return await Wallet.fromEncryptedJson(encryptedKey, pass);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to decrypt ${ENCRYPTED_KEY_ENV}: ${reason}. Wrong password?`);
  }
}
