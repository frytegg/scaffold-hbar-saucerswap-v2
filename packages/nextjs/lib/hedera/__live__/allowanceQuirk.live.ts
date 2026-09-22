import { swapRouterAbi } from "../abi";
import { testnet } from "../addresses";
import { explainError } from "../failure";
import { allowanceVerdict, readAllowance } from "../preflight";
import { type SwapCall, buildTokenToHbarSwap, minimumOut, quoteExactInput, swapDeadline, swapPath } from "../swap";
import { formatTokenAmount, tinybar } from "../units";
import { mirrorCallAccepts, testnetClient, testnetMirror } from "./testnet";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { beforeAll, describe, expect, it } from "vitest";

// A dated platform observation that the docs state and this file re-asserts: on Hedera testnet (relay 0.78.5, 21 and
// 22 Sept 2026) eth_call, eth_estimateGas and the mirror node's contracts/call all accepted a SAUCE -> HBAR swap whose
// sender had given the router no allowance, while the network rejected it (SPENDER_DOES_NOT_HAVE_ALLOWANCE).
// When this file fails because a simulator refuses, the observation has ended: the docs must say so.

/**
 * The account the swap is simulated from: 0.0.10650089, a testnet account of this project's research phase that holds
 * SAUCE and has never approved a spender. Nothing signs from it, so that its state stays what this check needs; the
 * evidence run's account does not qualify, since each run approves the router.
 */
const OBSERVER = { id: "0.0.10650089", evmAddress: "0xbA4C02365923b13f59c47DCf5A61dC674A511a16" } as const;

const sauce = testnet.sauce;
const amountIn = 1_000_000n;
const SLIPPAGE_BPS = 100;

let allowance: bigint;
let balance: bigint;
let quote: bigint;
let noAllowanceSwap: SwapCall;

function tokenToHbarSwap(amount: bigint): SwapCall {
  return buildTokenToHbarSwap({
    pool: testnet.hbarSaucePool,
    recipient: OBSERVER.evmAddress,
    slippageBps: SLIPPAGE_BPS,
    deadline: swapDeadline(600),
    amountIn: amount,
    quotedAmountOut: tinybar(quote),
  });
}

beforeAll(async () => {
  allowance = await readAllowance(testnetClient, sauce, OBSERVER.evmAddress);
  balance = (await testnetMirror.getTokenRelationship(OBSERVER.id, sauce.id))?.balance ?? 0n;
  if (allowance !== 0n || balance < amountIn) {
    throw new Error(
      `${OBSERVER.id} no longer fits this check: the account's state changed, not the platform or the code. It ` +
        `needs no allowance for the router and at least ${formatTokenAmount(amountIn, sauce)}; it has an allowance ` +
        `of ${formatTokenAmount(allowance, sauce)} and holds ${formatTokenAmount(balance, sauce)}. Simulate from ` +
        "another account in that state.",
    );
  }
  quote = await quoteExactInput(testnetClient, swapPath(sauce, testnet.hbarSaucePool.fee, testnet.whbar), amountIn);
  noAllowanceSwap = tokenToHbarSwap(amountIn);
  const relay = await testnetClient.request({ method: "web3_clientVersion" });
  console.info(`${relay}; ${OBSERVER.id} holds ${formatTokenAmount(balance, sauce)} and gave the router no allowance`);
});

describe("dated observation: the simulators accept a SAUCE -> HBAR swap that has no allowance", () => {
  it("the library's pre-flight blocks that swap, on the allowance read from the chain", () => {
    expect(allowanceVerdict(allowance, amountIn, sauce)).toMatchObject({ status: "fail", action: "approve" });
  });

  it("eth_call accepts it, and returns an amountOut within the swap's minimum", async () => {
    const { result } = await testnetClient.simulateContract({ ...noAllowanceSwap, account: OBSERVER.evmAddress });
    const amountOut = decodeFunctionResult({ abi: swapRouterAbi, functionName: "exactInput", data: result[0] });
    expect(amountOut).toBeGreaterThanOrEqual(minimumOut(quote, SLIPPAGE_BPS));
  });

  it("eth_estimateGas accepts it", async () => {
    expect(
      await testnetClient.estimateContractGas({ ...noAllowanceSwap, account: OBSERVER.evmAddress }),
    ).toBeGreaterThan(0n);
  });

  it("the mirror node's contracts/call accepts it", async () => {
    const data = encodeFunctionData(noAllowanceSwap);
    expect(await mirrorCallAccepts({ from: OBSERVER.evmAddress, to: noAllowanceSwap.address, data })).toBe(true);
  });

  it("control: eth_call still refuses the same swap for more SAUCE than the account holds", async () => {
    const tooMuch = tokenToHbarSwap(balance + amountIn);
    const refusal = await testnetClient.simulateContract({ ...tooMuch, account: OBSERVER.evmAddress }).then(
      () => null,
      (error: unknown) => explainError(error),
    );
    expect(refusal?.statusName).toBe("INSUFFICIENT_TOKEN_BALANCE");
  });
});
