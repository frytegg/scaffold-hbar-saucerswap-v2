import {
  type PanelCheck,
  SAUCERSWAP_UNAVAILABLE,
  type SwapDirection,
  SwapFormError,
  checkOf,
  checkOfRefusal,
  headlineFor,
  parseAmountInput,
  parseSlippagePercent,
  unitsOf,
} from "./swapPresentation";
import type { Hex, PublicClient } from "viem";
import {
  type BuiltCall,
  type CostVerdict,
  type EvmAddress,
  type HbarPoolEntry,
  type MirrorClient,
  type PreflightVerdict,
  type RecipientVerdict,
  type SwapCall,
  type Tinybar,
  type TokenEntry,
  buildHbarToTokenSwap,
  buildTokenToHbarSwap,
  checkAllowance,
  checkCost,
  checkRecipient,
  explainError,
  formatTokenAmount,
  minimumOut,
  quoteExactInput,
  swapDeadline,
  swapPath,
  testnet,
  tinybar,
  withGasLimit,
} from "~~/lib/hedera";

// Everything between "get a quote" and "the wallet may open": the quote, the call this page would send, the checks
// the network otherwise answers only after a send, and the cost preview. The reads are an argument, so that every
// refusal below has a test that needs no network.

type CostRequest = {
  call: BuiltCall;
  account: EvmAddress;
  autoAssociates: boolean;
  token: TokenEntry;
  hbarOut?: Tinybar;
  functions: readonly string[];
};

export type PlanReads = {
  quote(path: Hex, amountIn: bigint): Promise<bigint>;
  recipient(recipient: EvmAddress, token: TokenEntry): Promise<RecipientVerdict>;
  allowance(owner: EvmAddress, token: TokenEntry, amountIn: bigint): Promise<PreflightVerdict>;
  cost(request: CostRequest): Promise<CostVerdict>;
};

/** The reads as the browser makes them: JSON-RPC and mirror-node calls, both through this app's own origin. */
export function createPlanReads(client: PublicClient, mirror: MirrorClient): PlanReads {
  return {
    quote: (path, amountIn) => quoteExactInput(client, path, amountIn),
    recipient: (recipient, token) => checkRecipient(mirror, { recipient, token }),
    allowance: (owner, token, amountIn) => checkAllowance(client, { token, owner, amountIn }),
    cost: request => checkCost(client, request),
  };
}

export type SwapPlan = {
  readonly direction: SwapDirection;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly amountOutMinimum: bigint;
  readonly slippageBps: number;
  readonly call: SwapCall & { readonly gas?: bigint };
  /** Every pre-flight answer, in the order the panel shows them; one failing answer blocks the send. */
  readonly checks: readonly PanelCheck[];
  /** What the router needs an allowance for, when the allowance check refused the swap. */
  readonly approveAmount: bigint | null;
  readonly quotedAt: number;
};

/** A stage that refused: the line to show, and the heading it belongs under. */
export type Refusal = { readonly check: PanelCheck; readonly headline: string };

export type PlanResult = { readonly ok: true; readonly plan: SwapPlan } | ({ readonly ok: false } & Refusal);

export type PlanInput = {
  readonly reads: PlanReads;
  readonly account: EvmAddress;
  readonly pool: HbarPoolEntry;
  readonly direction: SwapDirection;
  readonly amountInput: string;
  readonly slippageInput: string;
  /** How long the router keeps accepting the swap after it is built. */
  readonly deadlineSeconds: number;
  readonly now: number;
};

type Stage = { readonly id: string; readonly label: string };

const FORM: Stage = { id: "form", label: "Amount and slippage" };
const QUOTE: Stage = { id: "quote", label: "Quote" };
const BUILD: Stage = { id: "build", label: "The swap this page would send" };
const PREFLIGHT_ID = "preflight";
const PREFLIGHT: Stage = { id: PREFLIGHT_ID, label: "Pre-flight" };
const COST: Stage = { id: "cost", label: "Network fee" };

/**
 * A stage that threw, as the line the panel shows: the library's own sentence, never viem's. An integration that
 * did not answer is named as that, because nothing about the swap itself is known then.
 */
function refusalOf({ id, label }: Stage, error: unknown): Refusal {
  if (error instanceof SwapFormError) {
    return { check: checkOfRefusal(id, label, { message: error.message, action: "none" }), headline: label };
  }
  const failure = explainError(error);
  return {
    check: checkOfRefusal(id, label, failure),
    headline: headlineFor(failure, { refused: label, unavailable: SAUCERSWAP_UNAVAILABLE }),
  };
}

/** The same refusal as one line of the panel, headed by what went wrong rather than by the stage's name. */
function refusalLine(stage: Stage, error: unknown): PanelCheck {
  const { check, headline } = refusalOf(stage, error);
  return { ...check, label: headline };
}

/** The functions the multicall runs: a gas rule names an inner function, not the multicall it is wrapped in. */
function innerFunctions(toHbar: boolean): readonly string[] {
  return toHbar ? ["exactInput", "unwrapWHBAR"] : ["exactInput", "refundETH"];
}

export async function buildSwapPlan(input: PlanInput): Promise<PlanResult> {
  const { reads, account, pool, direction, now } = input;
  const token = pool.token;
  const toHbar = direction === "token-to-hbar";

  let amountIn: bigint;
  let slippageBps: number;
  try {
    amountIn = parseAmountInput(input.amountInput, unitsOf(direction, token).input);
    slippageBps = parseSlippagePercent(input.slippageInput);
  } catch (error: unknown) {
    return { ok: false, ...refusalOf(FORM, error) };
  }

  const path = toHbar ? swapPath(token, pool.fee, testnet.whbar) : swapPath(testnet.whbar, pool.fee, token);
  let quotedAmountOut: bigint;
  try {
    quotedAmountOut = await reads.quote(path, amountIn);
  } catch (error: unknown) {
    return { ok: false, ...refusalOf(QUOTE, error) };
  }

  let call: SwapCall & { readonly gas?: bigint };
  let amountOutMinimum: bigint;
  try {
    const request = { pool, recipient: account, slippageBps, deadline: swapDeadline(input.deadlineSeconds, now) };
    const built = toHbar
      ? buildTokenToHbarSwap({ ...request, amountIn, quotedAmountOut: tinybar(quotedAmountOut) })
      : buildHbarToTokenSwap({ ...request, amountIn: tinybar(amountIn), quotedAmountOut });
    amountOutMinimum = minimumOut(quotedAmountOut, slippageBps);
    call = withGasLimit(built, { functions: innerFunctions(toHbar) });
  } catch (error: unknown) {
    return { ok: false, ...refusalOf(BUILD, error) };
  }

  const checks: PanelCheck[] = [];
  let approveAmount: bigint | null = null;
  let autoAssociates = false;
  try {
    if (toHbar) {
      const verdict = await reads.allowance(account, token, amountIn);
      if (verdict.status !== "pass") approveAmount = amountIn;
      const amount = formatTokenAmount(amountIn, token);
      checks.push(checkOf(PREFLIGHT_ID, "The router may spend your token", verdict, amount));
    } else {
      const verdict = await reads.recipient(account, token);
      autoAssociates = verdict.autoAssociates;
      checks.push(checkOf(PREFLIGHT_ID, `${token.symbol} can reach your account`, verdict));
    }
  } catch (error: unknown) {
    checks.push(refusalLine(PREFLIGHT, error));
  }

  if (!checks.some(check => check.status === "fail")) {
    try {
      const cost = await reads.cost({
        call,
        account,
        autoAssociates,
        token,
        hbarOut: toHbar ? tinybar(quotedAmountOut) : undefined,
        functions: innerFunctions(toHbar),
      });
      checks.push(checkOf(COST.id, COST.label, { ...cost, message: `${cost.message} ${cost.walletNote}` }));
    } catch (error: unknown) {
      checks.push(refusalLine(COST, error));
    }
  }

  return {
    ok: true,
    plan: {
      direction,
      amountIn,
      quotedAmountOut,
      amountOutMinimum,
      slippageBps,
      call,
      checks,
      approveAmount,
      quotedAt: now,
    },
  };
}
