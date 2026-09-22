"use client";

import { type SwapDirection, directionLabel, unitsOf } from "./swapPresentation";
import type { TokenEntry } from "~~/lib/hedera";

// The form. Nothing here asks the network anything: the quote starts when the button is pressed, so a first paint
// of this route makes no request at all outside the app's own origin.

const DIRECTIONS: readonly SwapDirection[] = ["hbar-to-token", "token-to-hbar"];

export const SwapForm = ({
  token,
  direction,
  amount,
  slippage,
  busy,
  onDirection,
  onAmount,
  onSlippage,
  onQuote,
}: {
  token: TokenEntry;
  direction: SwapDirection;
  amount: string;
  slippage: string;
  busy: boolean;
  onDirection: (direction: SwapDirection) => void;
  onAmount: (amount: string) => void;
  onSlippage: (slippage: string) => void;
  onQuote: () => void;
}) => {
  const { input, output } = unitsOf(direction, token);
  return (
    <section className="card bg-base-100 shadow p-5 flex flex-col gap-4">
      <h2 className="text-xl font-semibold m-0">Swap</h2>
      <div className="join">
        {DIRECTIONS.map(candidate => (
          <button
            key={candidate}
            className={`btn join-item btn-sm ${candidate === direction ? "btn-primary" : ""}`}
            onClick={() => onDirection(candidate)}
          >
            {directionLabel(candidate, token)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="form-control w-56">
          <span className="label-text">Amount in {input.symbol}</span>
          <input
            className="input input-bordered"
            inputMode="decimal"
            value={amount}
            onChange={event => onAmount(event.target.value)}
          />
        </label>
        <label className="form-control w-56">
          <span className="label-text">Most the price may move, in %</span>
          <input
            className="input input-bordered"
            inputMode="decimal"
            value={slippage}
            onChange={event => onSlippage(event.target.value)}
          />
        </label>
      </div>
      <button className="btn btn-primary w-fit" disabled={busy} onClick={onQuote}>
        {busy ? "Quoting…" : `Quote ${input.symbol} to ${output.symbol}`}
      </button>
      <p className="m-0 text-sm opacity-70">
        The quote and every check below run when you press this button. Until then this page asks the network nothing.
      </p>
    </section>
  );
};
