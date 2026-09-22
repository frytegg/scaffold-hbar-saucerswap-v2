"use client";

import { FailureNote, Row, TransactionLinks } from "./atoms";
import { type AmountUnit, MIRROR_UNAVAILABLE, SAUCERSWAP_UNAVAILABLE, headlineFor } from "./swapPresentation";
import { type TransactionOutcome, deliveredAmount, succeeded } from "./transactionOutcome";
import { type HederaFailure, formatHbar, formatTokenAmount, tinybar } from "~~/lib/hedera";

// What happened after the wallet sent it, read back from the mirror node. A failure is a sentence and an action,
// never a receipt the reader has to interpret: the reason a multicall erased is recovered before this renders.

/** What the swap really delivered, in the unit the person asked for; null for anything but a successful swap. */
function deliveredLine(outcome: TransactionOutcome | null, unit: AmountUnit | null): string | null {
  if (outcome === null || unit === null || !succeeded(outcome)) return null;
  const amount = deliveredAmount(outcome);
  return amount === null ? null : formatTokenAmount(amount, unit);
}

/** A signed amount of HBAR, with the sign a person reads rather than a negative number. */
function signedHbar(amount: bigint): string {
  return `${amount < 0n ? "-" : "+"}${formatHbar(tinybar(amount < 0n ? -amount : amount))}`;
}

export const OutcomeCard = ({
  title,
  outcome,
  pending,
  sendFailure,
  outputUnit,
}: {
  title: string;
  outcome: TransactionOutcome | null;
  pending: boolean;
  /** Why the wallet never sent it: a refusal of this page, or of the wallet itself. */
  sendFailure: HederaFailure | null;
  /** The unit of what the swap delivers, for the amount decoded from the transaction's return value. */
  outputUnit: AmountUnit | null;
}) => {
  if (sendFailure === null && outcome === null && !pending) return null;
  const delivered = deliveredLine(outcome, outputUnit);
  return (
    <section className="card bg-base-100 shadow p-5 flex flex-col gap-2">
      <h2 className="text-xl font-semibold m-0">{title}</h2>
      {sendFailure !== null && (
        <FailureNote
          headline={headlineFor(sendFailure, {
            refused: "Nothing was sent",
            unavailable: SAUCERSWAP_UNAVAILABLE,
          })}
          failure={sendFailure}
        />
      )}
      {pending && <p className="m-0 text-sm">Sent. Reading the outcome from the mirror node…</p>}
      {outcome !== null && (
        <>
          <Row label="Transaction" value={outcome.hash} />
          <TransactionLinks hash={outcome.hash} />
          {outcome.result !== null && (
            <>
              <Row label="Mirror node result" value={outcome.result.result} />
              <Row label="Gas used" value={outcome.result.gasUsed.toLocaleString("en-US")} />
            </>
          )}
          {outcome.fee !== null && <Row label="Network fee in the record" value={formatHbar(outcome.fee)} />}
          {outcome.senderMovement !== null && (
            <Row label="Your account's net HBAR movement" value={signedHbar(outcome.senderMovement)} />
          )}
          {delivered !== null && <Row label="Delivered" value={delivered} />}
          {outcome.failure !== null && (
            <FailureNote
              headline={headlineFor(outcome.failure, {
                refused: "The network refused it, and the fee was taken",
                unavailable: SAUCERSWAP_UNAVAILABLE,
              })}
              failure={outcome.failure}
            />
          )}
          {outcome.unread !== null && (
            <FailureNote
              headline={headlineFor(outcome.unread, {
                refused: "Part of the outcome could not be read",
                unavailable: MIRROR_UNAVAILABLE,
              })}
              failure={outcome.unread}
            />
          )}
        </>
      )}
    </section>
  );
};
