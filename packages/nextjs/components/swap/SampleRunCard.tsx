"use client";

import { useCallback, useState } from "react";
import { CheckLine } from "./atoms";
import { SAMPLE_ACCOUNT_ID, SAMPLE_AMOUNT, runSample, sampleLines } from "./sampleRun";
import type { PlanReads } from "./swapPlan";
import type { PanelCheck } from "./swapPresentation";
import { FailureNote } from "~~/components/hedera/atoms";
import { SAUCERSWAP_UNAVAILABLE, headlineFor } from "~~/components/hedera/failureText";
import { type HederaFailure, type TokenEntry, explainError } from "~~/lib/hedera";

// What a reviewer without a wallet can still watch happen: the quote and the pre-flight of a token-input swap, run
// against a fixed public address. It shows the verdicts the panel above would show, and it cannot send: there is no
// button here that signs, and no key for the address it reads.

export const SampleRunCard = ({ reads, token }: { reads: PlanReads | null; token: TokenEntry }) => {
  const [lines, setLines] = useState<readonly PanelCheck[] | null>(null);
  const [failure, setFailure] = useState<HederaFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const onRun = useCallback(async (): Promise<void> => {
    if (reads === null) return;
    setBusy(true);
    setLines(null);
    setFailure(null);
    try {
      setLines(sampleLines(await runSample(reads, Date.now())));
    } catch (error: unknown) {
      setFailure(explainError(error));
    } finally {
      setBusy(false);
    }
  }, [reads]);

  return (
    <section className="card bg-base-100 shadow p-5 flex flex-col gap-3">
      <h2 className="text-xl font-semibold m-0">The same checks, with no wallet</h2>
      <p className="m-0 text-sm">
        These checks take an address, not a key. This runs the quote and the whole pre-flight for {SAMPLE_AMOUNT}{" "}
        {token.symbol} against {SAMPLE_ACCOUNT_ID}, the account the transactions in{" "}
        <code>docs/hedera-behaviour.md</code> were sent from, and shows what Hedera testnet answers for it right now.
        Nothing is signed, nothing is sent, and every read leaves from this app&apos;s own origin.
      </p>
      <button
        className="btn btn-primary btn-sm w-fit"
        disabled={reads === null || busy}
        onClick={() => void onRun()}
        type="button"
      >
        {busy ? "Reading Hedera testnet…" : "Run the pre-flight"}
      </button>
      {reads === null && (
        <p className="m-0 text-sm">
          Hedera testnet is not among this app&apos;s target networks, so there is no client to read it with.
        </p>
      )}
      {lines !== null && (
        <ul className="list-none p-0 m-0 flex flex-col gap-3">
          {lines.map(line => (
            <CheckLine key={line.id} check={line} />
          ))}
        </ul>
      )}
      {failure !== null && (
        <FailureNote
          headline={headlineFor(failure, { refused: "The sample run stopped", unavailable: SAUCERSWAP_UNAVAILABLE })}
          failure={failure}
        />
      )}
    </section>
  );
};
