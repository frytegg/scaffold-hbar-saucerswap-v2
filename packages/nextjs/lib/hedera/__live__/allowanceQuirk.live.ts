import { testnet } from "../addresses";
import { explainError } from "../failure";
import { allowanceVerdict, readAllowance } from "../preflight";
import { type SwapCall, buildTokenToHbarSwap, quoteExactInput, swapDeadline, swapPath } from "../swap";
import { formatTokenAmount, tinybar } from "../units";
import { mirrorCallAccepts, readEvidence, testnetClient, testnetMirror } from "./testnet";
import { type Address, encodeFunctionData } from "viem";
import { beforeAll, describe, expect, it } from "vitest";

// A dated platform observation that the docs state and this file re-asserts: on Hedera testnet (relay 0.78.5, 21 and
// 22 Sept 2026) eth_call, eth_estimateGas and the mirror node's contracts/call all accepted a SAUCE -> HBAR swap whose
// sender had given the router no allowance, while the network rejected it (SPENDER_DOES_NOT_HAVE_ALLOWANCE).
// When this file fails because a simulator refuses, the observation has ended: the docs must say so.

const sauce = testnet.sauce;
const amountIn = 1_000_000n;

let owner: Address;
let balance: bigint;
let quote: bigint;
let noAllowanceSwap: SwapCall;

function tokenToHbarSwap(amount: bigint): SwapCall {
  return buildTokenToHbarSwap({
    pool: testnet.hbarSaucePool,
    recipient: owner,
    slippageBps: 100,
    deadline: swapDeadline(600),
    amountIn: amount,
    quotedAmountOut: tinybar(quote),
  });
}

beforeAll(async () => {
  // The evidence account's token -> HBAR swap used its exact allowance up: it holds SAUCE and has none left.
  const recorded = readEvidence().filter(({ record }) => record.swap.direction === "token-to-hbar");
  const newest = recorded.at(-1);
  if (newest === undefined) throw new Error("docs/evidence/ holds no token-to-hbar record to take the account from.");
  owner = newest.record.sender.evmAddress;

  const allowance = await readAllowance(testnetClient, sauce, owner);
  balance = (await testnetMirror.getTokenRelationship(owner, sauce.id))?.balance ?? 0n;
  if (allowance !== 0n || balance < amountIn) {
    throw new Error(
      `${owner} no longer fits this check: it needs no allowance for the router and at least ` +
        `${formatTokenAmount(amountIn, sauce)}; it has an allowance of ${formatTokenAmount(allowance, sauce)} ` +
        `and holds ${formatTokenAmount(balance, sauce)}.`,
    );
  }
  quote = await quoteExactInput(testnetClient, swapPath(sauce, testnet.hbarSaucePool.fee, testnet.whbar), amountIn);
  noAllowanceSwap = tokenToHbarSwap(amountIn);
  const relay = await testnetClient.request({ method: "web3_clientVersion" });
  console.info(`${relay}; ${owner} holds ${formatTokenAmount(balance, sauce)} and gave the router no allowance`);
});

describe("dated observation: the simulators accept a SAUCE -> HBAR swap that has no allowance", () => {
  it("the library's pre-flight blocks that swap", () => {
    expect(allowanceVerdict(0n, amountIn, sauce)).toMatchObject({ status: "fail", action: "approve" });
  });

  it("eth_call accepts it", async () => {
    await expect(testnetClient.simulateContract({ ...noAllowanceSwap, account: owner })).resolves.toBeDefined();
  });

  it("eth_estimateGas accepts it", async () => {
    expect(await testnetClient.estimateContractGas({ ...noAllowanceSwap, account: owner })).toBeGreaterThan(0n);
  });

  it("the mirror node's contracts/call accepts it", async () => {
    const data = encodeFunctionData(noAllowanceSwap);
    expect(await mirrorCallAccepts({ from: owner, to: noAllowanceSwap.address, data })).toBe(true);
  });

  it("control: eth_call still refuses the same swap for more SAUCE than the account holds", async () => {
    const tooMuch = tokenToHbarSwap(balance + amountIn);
    const refusal = await testnetClient.simulateContract({ ...tooMuch, account: owner }).then(
      () => null,
      (error: unknown) => explainError(error),
    );
    expect(refusal?.statusName).toBe("INSUFFICIENT_TOKEN_BALANCE");
  });
});
