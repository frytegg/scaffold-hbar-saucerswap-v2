"use client";

import type { ReactNode } from "react";
import { actionLabelFor } from "./failureText";
import type { HederaFailure } from "~~/lib/hedera";

// The two pieces every card of this template is built from: a labelled value, and a failure shown the same way
// wherever it happens — one sentence, the one thing to do about it, and where the explanation came from.

export const Row = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="flex flex-wrap gap-x-2 text-sm">
    <span className="font-semibold">{label}:</span>
    <span className="font-mono break-all">{value}</span>
  </div>
);

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
