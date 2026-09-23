"use client";

import { type CheckAction, CheckLine } from "./atoms";
import type { SwapPlan } from "./swapPlan";
import { type PanelCheck, type QuoteFreshness, blocks, sendIsBlocked, unitsOf } from "./swapPresentation";
import { Row } from "~~/components/hedera/atoms";
import { type TokenEntry, formatTokenAmount } from "~~/lib/hedera";

// The checks the network would otherwise answer only after the swap was signed, paid for and rejected. A failing
// one blocks the send: the wallet is never asked to sign something this page already knows will be refused.

export const PreflightPanel = ({
  plan,
  token,
  checks,
  freshness,
  approveAction,
  sendBusy,
  onSend,
}: {
  plan: SwapPlan;
  token: TokenEntry;
  /** The plan's own answers, behind what the token facade answered to an approval sent from this panel. */
  checks: readonly PanelCheck[];
  freshness: QuoteFreshness;
  approveAction: CheckAction | null;
  sendBusy: boolean;
  onSend: () => void;
}) => {
  const { input, output } = unitsOf(plan.direction, token);
  const blocked = blocks(checks);
  const amountIn = formatTokenAmount(plan.amountIn, input);
  const least = formatTokenAmount(plan.amountOutMinimum, output);

  return (
    <section className="card bg-base-100 shadow p-5 flex flex-col gap-4">
      <h2 className="text-xl font-semibold m-0">Before the wallet opens</h2>
      <div className="flex flex-col gap-1">
        <Row label="Quote" value={`${amountIn} for ${formatTokenAmount(plan.quotedAmountOut, output)}`} />
        <Row label="Least you accept" value={`${least} (${plan.slippageBps / 100} % under the quote)`} />
      </div>
      {freshness.message !== null && <div className="alert alert-warning text-sm">{freshness.message}</div>}
      <ul className="list-none p-0 m-0 flex flex-col gap-3">
        {checks.map(check => (
          <CheckLine
            key={check.id}
            check={check}
            action={approveAction === null || check.action !== "approve" ? undefined : approveAction}
          />
        ))}
      </ul>
      <button
        className="btn btn-primary w-fit"
        disabled={sendIsBlocked({ checks, freshness, sendBusy })}
        onClick={onSend}
      >
        {sendBusy ? "Waiting for the wallet…" : `Swap ${amountIn} for at least ${least}`}
      </button>
      {blocked && (
        <p className="m-0 text-sm">
          The send is blocked while a check above is blocked. Every one of them is a refusal the network would answer
          only after taking the gas.
        </p>
      )}
    </section>
  );
};
