import { type TokenEntry, testnet } from "../addresses";
import type { EvmAddress } from "../evmAddress";
import type { MirrorAccount, MirrorContractResult } from "../mirror";
import { approvalGranted } from "../swap";
import { type Tinybar, formatHbar, formatTokenAmount } from "../units";
import type { Hex } from "viem";

// The refusals of the signed evidence run (swaps.signed.ts), kept pure so that the offline tier fails each one and
// checks its message. Each throws before the send it guards.

export class EvidenceRunRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceRunRefusal";
  }
}

export function privateKeyOf(value: string): Hex {
  const key = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new EvidenceRunRefusal("__RUNTIME_DEPLOYER_PRIVATE_KEY is not a 32-byte private key in hexadecimal.");
  }
  return key as Hex;
}

export function assertTestnet(chainId: number): void {
  if (chainId !== testnet.chainId) {
    throw new EvidenceRunRefusal(
      `The JSON-RPC relay serves chain ${chainId}, not Hedera testnet (${testnet.chainId}). Nothing was signed.`,
    );
  }
}

/** The mirror node's account for the key's address: the run looks it up by the EVM address the key derives. */
export function signingAccount(found: MirrorAccount | null, address: EvmAddress): MirrorAccount {
  if (found === null) {
    throw new EvidenceRunRefusal(
      `No Hedera testnet account has the EVM address ${address}, the one this key derives: fund that address ` +
        "first, which creates the account. Nothing was signed.",
    );
  }
  return found;
}

/**
 * Refuses a send that could take the run's spending above `ceiling`. `spent` is the fall of the account's balance
 * since the run started, in tinybar: below 0 when the run has received more HBAR than it paid.
 */
export function assertWithinCeiling({
  spent,
  upTo,
  ceiling,
  what,
}: {
  spent: bigint;
  upTo: Tinybar;
  ceiling: Tinybar;
  what: string;
}): void {
  if (spent + upTo > ceiling) {
    throw new EvidenceRunRefusal(
      `${what} may cost up to ${formatHbar(upTo)}, and this run has already spent ${spent} tinybar: that could go ` +
        `over the run's ceiling of ${formatHbar(ceiling)}. Nothing was sent.`,
    );
  }
}

export function assertHolds({
  account,
  held,
  needed,
  token,
}: {
  account: string;
  held: bigint;
  needed: bigint;
  token: TokenEntry;
}): void {
  if (held < needed) {
    throw new EvidenceRunRefusal(
      `${account} holds ${formatTokenAmount(held, token)}; this swap needs ${formatTokenAmount(needed, token)}. ` +
        "Nothing was sent.",
    );
  }
}

/**
 * The consumer keeps the tokens it buys, and only its owner can take them out. A run signed by anyone else would
 * spend that signer's HBAR on tokens they can never reach, so it stops before the swap.
 */
export function assertOwnedBySigner({
  contract,
  owner,
  signer,
}: {
  contract: EvmAddress;
  owner: EvmAddress;
  signer: EvmAddress;
}): void {
  if (owner.toLowerCase() === signer.toLowerCase()) return;
  throw new EvidenceRunRefusal(
    `The consumer at ${contract} belongs to ${owner}, not to the signer ${signer}, and it keeps the tokens it ` +
      "buys: only its owner can withdraw them. Deploy your own with the hardhat:deploy:consumer:testnet script, " +
      "which rewrites the frontend's contract list, then run this again. Nothing was sent.",
  );
}

/** An HTS approve answers a bool: a successful transaction that returned false approved nothing. */
export function assertApprovalGranted(result: MirrorContractResult): void {
  if (result.callResult === null || !approvalGranted(result.callResult)) {
    throw new EvidenceRunRefusal(
      `${result.hash} succeeded but the token's approve did not return true. The swap was not sent.`,
    );
  }
}
