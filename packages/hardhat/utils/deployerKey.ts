import password from "@inquirer/password";
import { parse, stringify } from "envfile";
import { HDNodeWallet, Wallet } from "ethers";
import * as fs from "fs";
import { ENCRYPTED_KEY_ENV } from "./deployerAccount";

/** Relative to packages/hardhat, where the package's scripts run. */
const ENV_FILE = "./.env";

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

/**
 * Encrypts the wallet `obtainWallet` returns with a password asked twice and stores it in packages/hardhat/.env,
 * keeping the file's other variables. A key that is already stored is never replaced.
 * @returns the address of the stored key
 */
export async function storeDeployerKey(obtainWallet: () => Promise<Wallet | HDNodeWallet>): Promise<string> {
  const existing = fs.existsSync(ENV_FILE) ? parse(fs.readFileSync(ENV_FILE, "utf8")) : {};
  if (existing[ENCRYPTED_KEY_ENV]) {
    throw new Error(`packages/hardhat/.env already holds a deployer key (${ENCRYPTED_KEY_ENV}); nothing was changed.`);
  }

  const wallet = await obtainWallet();
  const encryptedKey = await wallet.encrypt(await askNewPassword());
  fs.writeFileSync(ENV_FILE, stringify({ ...existing, [ENCRYPTED_KEY_ENV]: encryptedKey }));
  return wallet.address;
}

async function askNewPassword(): Promise<string> {
  while (true) {
    const pass = await password({ message: "Enter a password to encrypt your private key:" });
    const confirmation = await password({ message: "Confirm password:" });
    if (pass === confirmation) {
      return pass;
    }
    console.log("❌ Passwords don't match. Please try again.");
  }
}
