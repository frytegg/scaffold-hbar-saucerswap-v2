"use client";

import type { ReactNode } from "react";
import {
  type PanelCheck,
  actionLabelFor,
  hashscanTransactionUrl,
  isInPageAction,
  mirrorResultUrl,
} from "./swapPresentation";
import type { Hex } from "viem";
import type { HederaFailure } from "~~/lib/hedera";

// The pieces every card of the swap route is built from. A failure is shown the same way wherever it happens: one
// sentence, the one thing to do about it, and where to read the transaction.

export const Row = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="flex flex-wrap gap-x-2 text-sm">
    <span className="font-semibold">{label}:</span>
    <span className="font-mono break-all">{value}</span>
  </div>
);

const BADGES: Record<PanelCheck["status"], { className: string; text: string }> = {
  pass: { className: "badge badge-success", text: "passed" },
  warn: { className: "badge badge-warning", text: "warning" },
  fail: { className: "badge badge-error", text: "blocked" },
};

export type CheckAction = { readonly label: string; readonly busy: boolean; readonly onClick: () => void };

export const CheckLine = ({ check, action }: { check: PanelCheck; action?: CheckAction }) => {
  const badge = BADGES[check.status];
  const offered = action !== undefined && isInPageAction(check.action);
  return (
    <li className="flex flex-col gap-1 border-t border-base-300 pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={badge.className}>{badge.text}</span>
        <span className="font-semibold">{check.label}</span>
      </div>
      <p className="m-0 text-sm">{check.message}</p>
      {offered ? (
        <button className="btn btn-primary btn-sm w-fit" disabled={action.busy} onClick={action.onClick}>
          {action.busy ? "Waiting for the wallet…" : action.label}
        </button>
      ) : (
        check.actionLabel !== null && <p className="m-0 text-sm font-medium">What to do: {check.actionLabel}</p>
      )}
    </li>
  );
};

export const FailureNote = ({ headline, failure }: { headline: string; failure: HederaFailure }) => {
  const advice = actionLabelFor(failure.action);
  return (
    <div className="alert alert-error flex flex-col items-start gap-1 text-sm">
      <span className="font-semibold">{headline}</span>
      <p className="m-0">{failure.message}</p>
      {advice !== null && <p className="m-0 font-medium">What to do: {advice}</p>}
      <p className="m-0 opacity-70">
        {failure.kind}
        {failure.statusName === null ? "" : ` · ${failure.statusName}`}
        {failure.code === null ? "" : ` · code ${failure.code}`} · read from {failure.via}
      </p>
    </div>
  );
};

/** The two places a transaction can be read: machine-readable on the mirror node, rendered on Hashscan. */
export const TransactionLinks = ({ hash }: { hash: Hex }) => (
  <div className="flex flex-wrap gap-4 text-sm">
    <a className="link" href={mirrorResultUrl(hash)} target="_blank" rel="noreferrer">
      Mirror node (DETAIL)
    </a>
    <a className="link" href={hashscanTransactionUrl(hash)} target="_blank" rel="noreferrer">
      Hashscan
    </a>
  </div>
);
