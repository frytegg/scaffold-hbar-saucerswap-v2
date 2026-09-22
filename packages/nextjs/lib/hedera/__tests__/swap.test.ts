import { testnet } from "../addresses";
import {
  SwapBuildError,
  type SwapBuildErrorCode,
  buildApproveCall,
  buildHbarToTokenSwap,
  buildTokenToHbarSwap,
  minimumOut,
  quoteExactInput,
  swapDeadline,
  swapPath,
} from "../swap";
import { hbarToTinybar, tinybar } from "../units";
import { mirrorBody, replayClient, rpcFixture } from "./replay";
import { encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

const MAIN = "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01";

function buildErrorOf(run: () => unknown): SwapBuildErrorCode {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof SwapBuildError) return error.code;
    throw error;
  }
  throw new Error("expected a SwapBuildError");
}

describe("the builders reproduce the calldata of the swaps that reached consensus", () => {
  it("HBAR -> SAUCE, tx 0x82c4…ff9d: multicall[exactInput, refundETH], 1 HBAR sent as 10^18 weibar", () => {
    const swap = buildHbarToTokenSwap({
      pool: testnet.hbarSaucePool,
      recipient: MAIN,
      slippageBps: 500,
      deadline: 1_790_024_196n,
      amountIn: hbarToTinybar("1"),
      quotedAmountOut: 46_434_742n,
    });
    const onChain = mirrorBody("result-hbar-to-token-success");
    expect(encodeFunctionData(swap)).toBe(onChain.function_parameters);
    expect(swap.value).toBe(10n ** 18n);
    expect(onChain.amount).toBe(100_000_000);
  });

  it("SAUCE -> HBAR, tx 0xf1c4…627d: multicall[exactInput to the router, unwrapWHBAR to the sender], value 0", () => {
    const swap = buildTokenToHbarSwap({
      pool: testnet.hbarSaucePool,
      recipient: MAIN,
      slippageBps: 500,
      deadline: 1_790_024_437n,
      amountIn: 10_000_000n,
      quotedAmountOut: tinybar(21_407_548n),
    });
    expect(encodeFunctionData(swap)).toBe(mirrorBody("result-token-to-hbar-success").function_parameters);
    expect(swap.value).toBe(0n);
  });

  it("the path is token, fee, token, packed", () => {
    expect(swapPath(testnet.whbar, 3000, testnet.sauce)).toBe(
      "0x0000000000000000000000000000000000003ad2000bb80000000000000000000000000000000000120f46",
    );
  });
});

describe("slippage is a parameter, and a zero minimum is refused", () => {
  it("takes the minimum output slippageBps under the quote, rounding down", () => {
    expect(minimumOut(46_434_742n, 500)).toBe(44_113_004n);
    expect(minimumOut(46_434_742n, 0)).toBe(46_434_742n);
  });

  it.each([
    [1n, 50],
    [0n, 0],
  ])("refuses a quote of %s at %s basis points: the minimum would be 0", (quote, bps) => {
    expect(buildErrorOf(() => minimumOut(quote, bps))).toBe("zero-minimum-out");
  });

  it.each([-1, 5_001, 9_999, 10_000, 0.5, Number.NaN])("refuses a slippage of %s basis points", bps => {
    expect(buildErrorOf(() => minimumOut(46_434_742n, bps))).toBe("invalid-slippage");
  });

  it("accepts at most half the quote, and says so when it refuses more", () => {
    expect(minimumOut(46_434_742n, 5_000)).toBe(23_217_371n);
    expect(() => minimumOut(46_434_742n, 9_999)).toThrow(
      "A slippage of 9999 basis points is not an integer from 0 to 5000 (half the quote).",
    );
  });

  it("no builder produces a swap with amountOutMinimum 0", () => {
    const request = { pool: testnet.hbarSaucePool, recipient: MAIN, slippageBps: 500, deadline: 1n };
    expect(buildErrorOf(() => buildHbarToTokenSwap({ ...request, amountIn: tinybar(1n), quotedAmountOut: 1n }))).toBe(
      "zero-minimum-out",
    );
    expect(buildErrorOf(() => buildTokenToHbarSwap({ ...request, amountIn: 1n, quotedAmountOut: tinybar(1n) }))).toBe(
      "zero-minimum-out",
    );
  });
});

describe("amounts stay within what HTS can move (int64)", () => {
  const request = { pool: testnet.hbarSaucePool, recipient: MAIN, slippageBps: 500, deadline: 1n };

  it.each([0n, 2n ** 63n])("refuses an input amount of %s", amountIn => {
    expect(buildErrorOf(() => buildTokenToHbarSwap({ ...request, amountIn, quotedAmountOut: tinybar(1_000n) }))).toBe(
      "amount-out-of-range",
    );
    expect(buildErrorOf(() => buildApproveCall(testnet.sauce, amountIn))).toBe("amount-out-of-range");
  });

  it("approves the router for the exact amount", () => {
    expect(buildApproveCall(testnet.sauce, 10_000_000n)).toMatchObject({
      address: testnet.sauce.evmAddress,
      functionName: "approve",
      args: [testnet.swapRouter.evmAddress, 10_000_000n],
    });
  });
});

describe("quote and deadline", () => {
  it("reads QuoterV2's amountOut from the captured eth_call: 1 HBAR -> 46.430539 SAUCE on 22 Sept", async () => {
    const client = replayClient([rpcFixture("call-quote-hbar-to-sauce")]);
    expect(await quoteExactInput(client, swapPath(testnet.whbar, 3000, testnet.sauce), 100_000_000n)).toBe(46_430_539n);
  });

  it("a deadline is now plus the time to live, in seconds", () => {
    expect(swapDeadline(600, 1_790_024_000_500)).toBe(1_790_024_600n);
  });
});
