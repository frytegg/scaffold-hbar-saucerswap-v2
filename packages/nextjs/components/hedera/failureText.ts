import type { FailureAction, HederaFailure } from "~~/lib/hedera";

// The words this template puts around a library answer: the one thing to do about a failure, and the heading it
// belongs under. Two routes show the same failures, and a reader should not have to learn two vocabularies.

const ACTION_LABELS: Record<Exclude<FailureAction, "approve" | "none">, string> = {
  associate: "Associate the token from that account first",
  fund: "Send HBAR to that address first",
  "scale-value": "The value this page built is not one the network carries: report it as a defect of the page",
  requote: "Get a new quote",
  retry: "Try again in a few seconds",
  "supply-gas": "This call needs a gas limit from the page: the limits are in lib/hedera/gasRules.ts",
};

/** The actions a route can carry out itself, as a button next to the sentence. */
const IN_PAGE_ACTIONS = new Set<FailureAction>(["approve", "requote", "retry"]);

export function isInPageAction(action: FailureAction): boolean {
  return IN_PAGE_ACTIONS.has(action);
}

/**
 * The imperative shown next to a verdict or a failure. `approve` names the amount, because approving less than the
 * swap spends is the mistake the network reports as a missing allowance.
 */
export function actionLabelFor(action: FailureAction, approveAmount?: string): string | null {
  if (action === "none") return null;
  if (action === "approve") {
    return approveAmount === undefined ? "Approve the router" : `Approve ${approveAmount} for the router`;
  }
  return ACTION_LABELS[action];
}

export const SAUCERSWAP_UNAVAILABLE = "SaucerSwap testnet unavailable";
export const MIRROR_UNAVAILABLE = "Hedera testnet unavailable";

/**
 * The heading a failure gets. Something that did not answer is not a refusal: the page says so, because the person
 * can do nothing but wait, and what they asked for may be perfectly sound.
 */
export function headlineFor(
  failure: HederaFailure,
  headlines: { readonly refused: string; readonly unavailable: string },
): string {
  const silent = failure.kind === "unavailable" || failure.kind === "rate-limited";
  return silent ? headlines.unavailable : headlines.refused;
}
