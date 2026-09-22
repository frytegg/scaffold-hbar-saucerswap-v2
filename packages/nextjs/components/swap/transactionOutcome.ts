import type { Hex } from "viem";
import {
  type EntityId,
  type HederaFailure,
  type MirrorClient,
  type MirrorContractResult,
  type Tinybar,
  explainContractResult,
  explainError,
  netTransfer,
  networkFee,
  postMortem,
  swapAmountOut,
} from "~~/lib/hedera";

// What became of a transaction the wallet sent, read from the mirror node: it is the source of truth for the
// outcome, it keeps the revert reason SaucerSwap's multicall erases, and its transfer list is where a fee that was
// really moved is read. Nothing here throws: a sent transaction always has something to show.

export type TransactionOutcome = {
  readonly hash: Hex;
  readonly result: MirrorContractResult | null;
  /** The fee the record moved to the network's own accounts. */
  readonly fee: Tinybar | null;
  /** What the sender's account gained or paid, fee included: on a revert the relay's operator pays a part. */
  readonly senderMovement: bigint | null;
  /** Why the transaction failed, decoded; null while it succeeded or is not known. */
  readonly failure: HederaFailure | null;
  /** Why part of the outcome could not be read. The transaction was sent either way. */
  readonly unread: HederaFailure | null;
};

export function succeeded(outcome: TransactionOutcome): boolean {
  return outcome.result?.result === "SUCCESS";
}

/**
 * What the swap delivered, decoded from the multicall's own return value. Null when the transaction returned
 * something else: an approval through the token facade answers a bool, not a swap result.
 */
export function deliveredAmount(outcome: TransactionOutcome): bigint | null {
  const callResult = outcome.result?.callResult ?? null;
  if (callResult === null || !succeeded(outcome)) return null;
  try {
    return swapAmountOut(callResult);
  } catch {
    return null;
  }
}

export async function trackTransaction(
  mirror: MirrorClient,
  hash: Hex,
  sender: EntityId | null,
): Promise<TransactionOutcome> {
  const nothingRead = { hash, result: null, fee: null, senderMovement: null, failure: null };
  let result: MirrorContractResult;
  try {
    result = await mirror.waitForResult(hash);
  } catch (error: unknown) {
    return { ...nothingRead, unread: explainError(error) };
  }

  let unread: HederaFailure | null = null;
  let failure: HederaFailure | null = null;
  try {
    failure = await postMortem(mirror, result);
  } catch (error: unknown) {
    // The result itself already names many failures; only the reason a multicall erased needs the actions view.
    failure = explainContractResult(result);
    unread = explainError(error);
  }

  let fee: Tinybar | null = null;
  let senderMovement: bigint | null = null;
  try {
    const record = await mirror.getTransaction(result.timestamp);
    if (record !== null) {
      fee = networkFee(record.transfers);
      senderMovement = sender === null ? null : netTransfer(record.transfers, sender);
    }
  } catch (error: unknown) {
    unread = unread ?? explainError(error);
  }

  return { hash, result, fee, senderMovement, failure, unread };
}
