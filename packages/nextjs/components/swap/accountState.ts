import type { PublicClient } from "viem";
import {
  type EvmAddress,
  type MirrorAccount,
  type MirrorClient,
  type MirrorTokenRelationship,
  type TokenEntry,
  readAllowance,
} from "~~/lib/hedera";

// Everything the account block shows, read in one pass: the mirror node knows the Hedera account, its automatic
// association slots and its token relationship; the allowance is read from the token facade, the same call the
// pre-flight check makes.

export type AccountState = {
  readonly address: EvmAddress;
  /** null when no Hedera account exists at this address yet, which is all a fresh wallet address has. */
  readonly account: MirrorAccount | null;
  /** null when the account holds no relationship with the token: it is not associated with it. */
  readonly relationship: MirrorTokenRelationship | null;
  /** null when there was no account to read an allowance for. */
  readonly routerAllowance: bigint | null;
};

export async function readAccountState(
  client: PublicClient,
  mirror: MirrorClient,
  address: EvmAddress,
  token: TokenEntry,
): Promise<AccountState> {
  const account = await mirror.getAccount(address);
  if (account === null) return { address, account: null, relationship: null, routerAllowance: null };
  const [relationship, routerAllowance] = await Promise.all([
    mirror.getTokenRelationship(account.accountId, token.id),
    readAllowance(client, token, address),
  ]);
  return { address, account, relationship, routerAllowance };
}

/** How the account receives the token today: the sentence the account block shows next to the association. */
export function associationSummary(state: AccountState, token: TokenEntry): string {
  const { account, relationship } = state;
  if (account === null) return `No Hedera account exists at ${state.address} yet.`;
  if (relationship !== null) {
    const how = relationship.automaticAssociation ? "automatically, inside a transaction" : "explicitly";
    return `Associated with ${token.symbol} (${how}).`;
  }
  const slots = account.maxAutomaticTokenAssociations;
  if (slots === -1) return `Not associated with ${token.symbol}, and has unlimited automatic association slots.`;
  if (slots === 0) return `Not associated with ${token.symbol}, and has no automatic association slot.`;
  return `Not associated with ${token.symbol}, and has ${slots} automatic association slots.`;
}
