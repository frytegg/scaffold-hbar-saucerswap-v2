import { htsTokenAbi, quoterV2Abi, swapRouterAbi } from "./abi";
import { type HbarPoolEntry, type TokenEntry, testnet } from "./addresses";
import { type Tinybar, type Weibar, payable, tinybar } from "./units";
import {
  type Address,
  type Hex,
  type PublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  encodePacked,
} from "viem";

export type SwapBuildErrorCode = "invalid-slippage" | "zero-minimum-out" | "amount-out-of-range";

export class SwapBuildError extends Error {
  readonly code: SwapBuildErrorCode;

  constructor(code: SwapBuildErrorCode, message: string) {
    super(message);
    this.name = "SwapBuildError";
    this.code = code;
  }
}

/** A router `multicall`, ready for viem's `simulateContract` / `writeContract` or wagmi's hooks. */
export type SwapCall = {
  readonly address: Address;
  readonly abi: typeof swapRouterAbi;
  readonly functionName: "multicall";
  readonly args: readonly [readonly Hex[]];
  readonly value: Weibar;
};

export type ApproveCall = {
  readonly address: Address;
  readonly abi: typeof htsTokenAbi;
  readonly functionName: "approve";
  readonly args: readonly [Address, bigint];
};

type SwapRequest = {
  pool: HbarPoolEntry;
  /** The account that receives the output: its `evm_address` from the mirror node, never its long-zero form. */
  recipient: Address;
  slippageBps: number;
  /** Unix time in seconds after which the router refuses the swap ("Transaction too old"). */
  deadline: bigint;
};

const BASIS_POINTS = 10_000;
// HTS amounts are int64: the router casts every amount it moves and reverts above this.
const MAX_HTS_AMOUNT = 2n ** 63n - 1n;

function assertHtsAmount(amount: bigint, what: string): void {
  if (amount <= 0n || amount > MAX_HTS_AMOUNT) {
    throw new SwapBuildError(
      "amount-out-of-range",
      `${what} must be above 0 and at most 2^63 - 1 (HTS amounts are int64).`,
    );
  }
}

/** The least output to accept, `slippageBps` basis points under the quote. Never 0: a zero minimum accepts any price. */
export function minimumOut(quotedAmountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= BASIS_POINTS) {
    throw new SwapBuildError(
      "invalid-slippage",
      `A slippage of ${slippageBps} basis points is not an integer from 0 to 9999.`,
    );
  }
  const minimum = (quotedAmountOut * BigInt(BASIS_POINTS - slippageBps)) / BigInt(BASIS_POINTS);
  if (minimum <= 0n) {
    throw new SwapBuildError(
      "zero-minimum-out",
      `A quote of ${quotedAmountOut} leaves a minimum output of 0 at ${slippageBps} basis points of slippage, and a swap ` +
        "with no minimum accepts any price. Quote a larger amount.",
    );
  }
  return minimum;
}

/** A single-pool path: token in, fee, token out, packed as the router and the quoter read it. */
export function swapPath(tokenIn: TokenEntry, fee: number, tokenOut: TokenEntry): Hex {
  return encodePacked(["address", "uint24", "address"], [tokenIn.evmAddress, fee, tokenOut.evmAddress]);
}

export function swapDeadline(ttlSeconds: number, nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000) + ttlSeconds);
}

/** HBAR in: `multicall[exactInput, refundETH]`, paid with the transaction value; refundETH returns what exactInput left. */
export function buildHbarToTokenSwap(request: SwapRequest & { amountIn: Tinybar; quotedAmountOut: bigint }): SwapCall {
  const { pool, recipient, slippageBps, deadline, amountIn, quotedAmountOut } = request;
  assertHtsAmount(amountIn, "amountIn");
  const exactInput = encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInput",
    args: [
      {
        path: swapPath(testnet.whbar, pool.fee, pool.token),
        recipient,
        deadline,
        amountIn,
        amountOutMinimum: minimumOut(quotedAmountOut, slippageBps),
      },
    ],
  });
  const refundETH = encodeFunctionData({ abi: swapRouterAbi, functionName: "refundETH" });
  return {
    address: testnet.swapRouter.evmAddress,
    abi: swapRouterAbi,
    functionName: "multicall",
    args: [[exactInput, refundETH]],
    ...payable(amountIn),
  };
}

/**
 * Token in, native HBAR out, in one transaction and with value 0: `exactInput` leaves the WHBAR in the router
 * (recipient = the router itself) and `unwrapWHBAR` sends it on as HBAR. Never split it in two transactions: between
 * them the WHBAR sits in the router, where anyone's `unwrapWHBAR` can take it. The router needs an allowance first.
 */
export function buildTokenToHbarSwap(request: SwapRequest & { amountIn: bigint; quotedAmountOut: Tinybar }): SwapCall {
  const { pool, recipient, slippageBps, deadline, amountIn, quotedAmountOut } = request;
  assertHtsAmount(amountIn, "amountIn");
  const amountOutMinimum = minimumOut(quotedAmountOut, slippageBps);
  const exactInput = encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInput",
    args: [
      {
        path: swapPath(pool.token, pool.fee, testnet.whbar),
        recipient: testnet.swapRouter.evmAddress,
        deadline,
        amountIn,
        amountOutMinimum,
      },
    ],
  });
  const unwrapWHBAR = encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "unwrapWHBAR",
    args: [amountOutMinimum, recipient],
  });
  return {
    address: testnet.swapRouter.evmAddress,
    abi: swapRouterAbi,
    functionName: "multicall",
    args: [[exactInput, unwrapWHBAR]],
    ...payable(tinybar(0n)),
  };
}

/** Lets the router pull `amount` of `token` from the sender: the exact amount of the swap. */
export function buildApproveCall(token: TokenEntry, amount: bigint): ApproveCall {
  assertHtsAmount(amount, "The approved amount");
  return {
    address: token.evmAddress,
    abi: htsTokenAbi,
    functionName: "approve",
    args: [testnet.swapRouter.evmAddress, amount],
  };
}

/** What a swap multicall delivered, from its return value (the mirror's `call_result`): exactInput's amountOut. */
export function swapAmountOut(callResult: Hex): bigint {
  const [exactInputResult] = decodeFunctionResult({ abi: swapRouterAbi, functionName: "multicall", data: callResult });
  return decodeFunctionResult({ abi: swapRouterAbi, functionName: "exactInput", data: exactInputResult });
}

/** Whether an HTS token's approve returned true. It answers a bool, not a response code. */
export function approvalGranted(callResult: Hex): boolean {
  return decodeFunctionResult({ abi: htsTokenAbi, functionName: "approve", data: callResult });
}

/** QuoterV2's answer for `amountIn` along `path`, read with eth_call: nothing is sent. */
export async function quoteExactInput(client: PublicClient, path: Hex, amountIn: bigint): Promise<bigint> {
  const { result } = await client.simulateContract({
    address: testnet.quoterV2.evmAddress,
    abi: quoterV2Abi,
    functionName: "quoteExactInput",
    args: [path, amountIn],
  });
  return result[0];
}
