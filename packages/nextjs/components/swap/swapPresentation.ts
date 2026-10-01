import type { Hex } from "viem";
import { actionLabelFor } from "~~/components/hedera/failureText";
import {
  type EvmAddress,
  type FailureAction,
  type HederaFailure,
  type PreflightVerdict,
  type TokenEntry,
  facadeResultVerdict,
} from "~~/lib/hedera";

// What the swap route turns library answers into: the text on the screen, the one action offered next to it, and
// the refusals the form itself can name before anything is read from the network.

export type SwapDirection = "hbar-to-token" | "token-to-hbar";

/** An amount's unit: the symbol shown and the decimals its smallest integer unit has. */
export type AmountUnit = { readonly symbol: string; readonly decimals: number };

export const HBAR_UNIT: AmountUnit = { symbol: "HBAR", decimals: 8 };

export function unitsOf(direction: SwapDirection, token: TokenEntry): { input: AmountUnit; output: AmountUnit } {
  return direction === "hbar-to-token" ? { input: HBAR_UNIT, output: token } : { input: token, output: HBAR_UNIT };
}

export function directionLabel(direction: SwapDirection, token: TokenEntry): string {
  const { input, output } = unitsOf(direction, token);
  return `${input.symbol} to ${output.symbol}`;
}

export type SwapFormErrorCode =
  | "not-an-amount"
  | "too-many-decimals"
  | "amount-is-zero"
  | "not-a-percentage"
  | "slippage-too-precise"
  | "slippage-accepts-any-price";

/** What the form refuses on its own, before a quote: the person typed something the swap cannot be built from. */
export class SwapFormError extends Error {
  readonly code: SwapFormErrorCode;

  constructor(code: SwapFormErrorCode, message: string) {
    super(message);
    this.name = "SwapFormError";
    this.code = code;
  }
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const SLIPPAGE_DECIMALS = 2;
/** 100 % of slippage accepts any price at all, which is the one thing a minimum output exists to prevent. */
const SLIPPAGE_CEILING_PERCENT = 100;

/**
 * An amount typed in `unit`, as its smallest integer unit and without going through floating point. The library's
 * `hbarToTinybar` does this for HBAR; a form that swaps both ways needs the same refusals for a token whose
 * decimals come from the address book.
 */
export function parseAmountInput(input: string, unit: AmountUnit): bigint {
  const match = DECIMAL.exec(input.trim());
  if (match === null) {
    throw new SwapFormError("not-an-amount", `"${input}" is not an amount of ${unit.symbol}, such as 1 or 0.25.`);
  }
  const [, whole, fraction = ""] = match;
  if (fraction.length > unit.decimals) {
    throw new SwapFormError(
      "too-many-decimals",
      `${unit.symbol} has ${unit.decimals} decimals: "${input}" has ${fraction.length}.`,
    );
  }
  const amount = BigInt(whole + fraction.padEnd(unit.decimals, "0"));
  if (amount === 0n) {
    throw new SwapFormError("amount-is-zero", `Enter an amount of ${unit.symbol} above 0: there is nothing to quote.`);
  }
  return amount;
}

/**
 * A slippage typed as a percentage, as the basis points the router's minimum output is computed in. How much
 * slippage a swap may carry at all is the library's rule, and `minimumOut` states it.
 */
export function parseSlippagePercent(input: string): number {
  const match = DECIMAL.exec(input.trim());
  if (match === null) throw new SwapFormError("not-a-percentage", `"${input}" is not a percentage, such as 0.5.`);
  const [, whole, fraction = ""] = match;
  if (fraction.length > SLIPPAGE_DECIMALS) {
    throw new SwapFormError(
      "slippage-too-precise",
      `A slippage is set in hundredths of a percent at most: "${input}" is finer than that.`,
    );
  }
  const percent = Number(whole);
  if (percent >= SLIPPAGE_CEILING_PERCENT) {
    throw new SwapFormError(
      "slippage-accepts-any-price",
      `A slippage of ${input} % leaves no minimum output, so the swap would accept any price it is given.`,
    );
  }
  return percent * 100 + Number(fraction.padEnd(SLIPPAGE_DECIMALS, "0"));
}

/** A check shown in the pre-flight panel: one line, one sentence, and the one thing to do about it. */
export type PanelCheck = {
  readonly id: string;
  readonly label: string;
  readonly status: PreflightVerdict["status"];
  readonly message: string;
  readonly action: FailureAction;
  /** The imperative next to the sentence, null when the message is the whole answer. */
  readonly actionLabel: string | null;
};

export function checkOf(id: string, label: string, verdict: PreflightVerdict, approveAmount?: string): PanelCheck {
  return {
    id,
    label,
    status: verdict.status,
    message: verdict.message,
    action: verdict.action,
    actionLabel: verdict.status === "pass" ? null : actionLabelFor(verdict.action, approveAmount),
  };
}

/** A refusal shown as a check of its own, so that a refusal and a passed check read the same way. */
export function checkOfRefusal(
  id: string,
  label: string,
  refusal: Pick<HederaFailure, "message" | "action">,
): PanelCheck {
  return {
    id,
    label,
    status: "fail",
    message: refusal.message,
    action: refusal.action,
    actionLabel: actionLabelFor(refusal.action),
  };
}

export function blocks(checks: readonly PanelCheck[]): boolean {
  return checks.some(check => check.status === "fail");
}

/**
 * Whether the send may not happen. This is the safety property of the route: a failing check is a refusal the
 * network would otherwise answer after taking the gas, and a stale quote carries a minimum output nobody has looked
 * at since. The button is disabled on this answer and the handler asks it again, so the rule lives in one place.
 */
export function sendIsBlocked({
  checks,
  freshness,
  sendBusy,
}: {
  checks: readonly PanelCheck[];
  freshness: QuoteFreshness;
  sendBusy: boolean;
}): boolean {
  return blocks(checks) || freshness.stale || sendBusy;
}

/**
 * Whether a plan may still be sent by the account currently connected. A wallet can switch account under the
 * page without reloading it, and a plan built for the previous account names it as the recipient and carries
 * checks read for it, so sending that plan from a new account pays the old one against an allowance the new one
 * never granted. The page also drops the plan on a switch; this is the answer that does not depend on an effect
 * having run.
 */
export function planBelongsTo(plan: { readonly account: EvmAddress }, account: EvmAddress | null): boolean {
  return account !== null && plan.account === account;
}

/**
 * What an HTS facade call returned, read from the mirror node's `call_result` after the transaction succeeded. The
 * ERC-20 shape is a bool; the facade answers a Hedera response code for the operations that have one. A failed HTS
 * operation is a successful, charged transaction, so the receipt alone never says whether it happened.
 */
export function facadeReturnVerdict(callResult: Hex | null): PreflightVerdict {
  const WORD_LENGTH = 66;
  if (callResult === null || callResult.length !== WORD_LENGTH) {
    return {
      check: "facade-result",
      status: "fail",
      action: "retry",
      message:
        "The transaction succeeded and returned no value, so whether the HTS operation happened is unknown. " +
        "Read the allowance again.",
    };
  }
  const word = BigInt(callResult);
  if (word === 1n) {
    return {
      check: "facade-result",
      status: "pass",
      action: "none",
      message: "The token facade returned true: the approval went through.",
    };
  }
  if (word === 0n) {
    return {
      check: "facade-result",
      status: "fail",
      action: "retry",
      message:
        "The token facade returned false: the approval did not happen, although the transaction succeeded and was " +
        "charged.",
    };
  }
  return facadeResultVerdict(word);
}

/** A quote is the price of one moment: past this, the swap is sent against a price nobody looked at. */
export const QUOTE_TTL_MS = 60_000;

export type QuoteFreshness = { readonly secondsOld: number; readonly stale: boolean; readonly message: string | null };

export function quoteFreshness(quotedAt: number, now: number): QuoteFreshness {
  const secondsOld = Math.max(0, Math.floor((now - quotedAt) / 1000));
  if (now - quotedAt < QUOTE_TTL_MS) return { secondsOld, stale: false, message: null };
  return {
    secondsOld,
    stale: true,
    message:
      `This quote is ${secondsOld} seconds old, past the ${QUOTE_TTL_MS / 1000} seconds this page keeps one: the ` +
      "price moves, and the swap would be sent against a minimum nobody looked at. Get a new quote.",
  };
}
