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

/**
 * Whether the mirror node says `account` sent this transaction. The mirror reports `from` in long-zero form even for
 * an account that signs with its own EVM address, so comparing `from` with a wallet address fails every time.
 */
export function isSentBy(result: MirrorContractResult, account: MirrorAccount): boolean {
  const sender = entityIdOfLongZero(result.from);
  if (sender !== null) return sender === account.accountId;
  return result.from.toLowerCase() === account.evmAddress.toLowerCase();
}
