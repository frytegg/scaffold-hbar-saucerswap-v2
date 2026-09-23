import { type PlanReads, type PlanResult, buildSwapPlan } from "./swapPlan";
import type { PanelCheck, SwapDirection } from "./swapPresentation";
import { type EvmAddress, testnet } from "~~/lib/hedera";

// The same quote and the same pre-flight as the panel above, against a fixed account, so that the refusal this
// template exists for can be watched without a wallet, a key or an account. Everything here is a read: the plan it
// builds carries a call, and nothing in this module or in the card that uses it hands that call to anything.

/**
 * The account the transactions of `docs/hedera-behaviour.md` were sent from, `0.0.10645914`. Its address is public
 * and is all these checks take; no key for it exists anywhere in this repository.
 */
export const SAMPLE_ACCOUNT: EvmAddress = "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01";
export const SAMPLE_ACCOUNT_ID = "0.0.10645914";

/** A token-input swap: its allowance is the check that no simulator makes, which is the point of the whole page. */
export const SAMPLE_DIRECTION: SwapDirection = "token-to-hbar";
export const SAMPLE_AMOUNT = "1";
export const SAMPLE_SLIPPAGE = "0.5";

/** The same deadline the route uses; nothing is sent against it, and it keeps the built call identical. */
const DEADLINE_SECONDS = 1_200;

export function runSample(reads: PlanReads, now: number): Promise<PlanResult> {
  return buildSwapPlan({
    reads,
    account: SAMPLE_ACCOUNT,
    pool: testnet.hbarSaucePool,
    direction: SAMPLE_DIRECTION,
    amountInput: SAMPLE_AMOUNT,
    slippageInput: SAMPLE_SLIPPAGE,
    deadlineSeconds: DEADLINE_SECONDS,
    now,
  });
}

/**
 * What the sample answered, as the lines a panel shows. A stage that refused before the checks began is one line of
 * the same shape, so the reader sees a refusal in the place a verdict would have been.
 */
export function sampleLines(result: PlanResult): readonly PanelCheck[] {
  return result.ok ? result.plan.checks : [result.check];
}
