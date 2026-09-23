import type { EntityId } from "./addresses";
import type { EvmAddress } from "./evmAddress";
import type { MirrorAccount, MirrorContractResult } from "./mirror";

// An account id written as an address: 4 bytes of shard and 8 of realm (all zero here), then 8 of account number.
const LONG_ZERO = /^0x0{24}([0-9a-fA-F]{16})$/;

/** True for 0x000…<account number>: the address form of an account id in shard 0, realm 0. */
export function isLongZeroAddress(address: EvmAddress): boolean {
  return LONG_ZERO.test(address);
}

/** The account id a long-zero address stands for, or null for any other address. */
export function entityIdOfLongZero(address: EvmAddress): EntityId | null {
  const match = LONG_ZERO.exec(address);
  return match === null ? null : (`0.0.${BigInt(`0x${match[1]}`)}` as EntityId);
}

/** How wide each part of an entity id is in that address: shard 4 bytes, realm 8, number 8. */
const PART_DIGITS = [8, 16, 16];

/**
 * The address form of an account id, which is what `AccountId.toSolidityAddress()` produces. It is the address an
 * account has before it has one of its own, and the wrong one to pay an account that does have one: `recipientVerdict`
 * is what tells those two apart. Null for anything that is not an id, or whose parts do not fit the widths above.
 */
export function longZeroAddressOf(id: EntityId): EvmAddress | null {
  const parts = id.split(".");
  if (parts.length !== PART_DIGITS.length || parts.some(part => !/^\d+$/.test(part))) return null;
  const digits = parts.map((part, index) => BigInt(part).toString(16).padStart(PART_DIGITS[index], "0"));
  if (digits.some((hex, index) => hex.length > PART_DIGITS[index])) return null;
  return `0x${digits.join("")}`;
}

/**
 * Whether the mirror node says `account` sent this transaction. The mirror reports `from` in long-zero form even for
 * an account that signs with its own EVM address, so comparing `from` with a wallet address fails every time.
 */
export function isSentBy(result: MirrorContractResult, account: MirrorAccount): boolean {
  const sender = entityIdOfLongZero(result.from);
  if (sender !== null) return sender === account.accountId;
  return result.from.toLowerCase() === account.evmAddress.toLowerCase();
}
