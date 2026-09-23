"use client";

import type { PanelCheck } from "./swapPresentation";
import type { Hex } from "viem";
import { isInPageAction } from "~~/components/hedera/failureText";
import { hashscanTransactionUrl, mirrorResultUrl } from "~~/components/hedera/links";

// The pieces the swap route adds to the shared cards of `components/hedera`: a pre-flight line, which carries the
// one action this page can take itself, and the pair of links every transaction is read at.

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
