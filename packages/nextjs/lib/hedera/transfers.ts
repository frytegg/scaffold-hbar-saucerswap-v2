import type { EntityId } from "./addresses";
import type { MirrorTransfer } from "./mirror";
import { type Tinybar, tinybar } from "./units";

// Hedera reserves the entity numbers up to 1000 for system accounts: the nodes, the fee collection account (0.0.802
// on testnet in September 2026) and the reward accounts. A transaction's network fee is what its record credits them.
const LAST_SYSTEM_ACCOUNT = 1000n;

function isSystemAccount(account: EntityId): boolean {
  const [shard, realm, num] = account.split(".").map(BigInt);
  return shard === 0n && realm === 0n && num <= LAST_SYSTEM_ACCOUNT;
}

/**
 * The network fee of a transaction as its HBAR transfer list moved it. The mirror's `charged_tx_fee` is not used: it
 * can differ from what was moved (it over-reports when a child token creation fails). Who paid the fee is another
 * question: on a reverted EVM transaction the relay's operator pays a part of it, which netTransfer shows.
 */
export function networkFee(transfers: readonly MirrorTransfer[]): Tinybar {
  return tinybar(
    transfers
      .filter(transfer => isSystemAccount(transfer.account) && transfer.amount > 0n)
      .reduce((sum, transfer) => sum + transfer.amount, 0n),
  );
}

/** What `account` gained (positive) or paid (negative) in HBAR, fee included; 0 when it is not in the list. */
export function netTransfer(transfers: readonly MirrorTransfer[], account: EntityId): bigint {
  return transfers
    .filter(transfer => transfer.account === account)
    .reduce((sum, transfer) => sum + transfer.amount, 0n);
}
