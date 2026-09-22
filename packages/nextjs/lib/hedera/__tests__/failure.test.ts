import { swapRevertAbi, swapRouterAbi } from "../abi";
import { testnet } from "../addresses";
import { explainContractResult, explainError, explainResponseCode, postMortem } from "../failure";
import { MirrorError, createMirrorClient } from "../mirror";
import { mirrorPaths } from "../mirrorPaths";
import { SwapBuildError, buildHbarToTokenSwap, minimumOut, quoteExactInput, swapPath } from "../swap";
import { UnitError, assertJsonRpcValue, hbarToTinybar, tinybar } from "../units";
import { mirrorBody, mirrorFixture, replayClient, replayFetch, replayMirror, rpcFixture } from "./replay";
import { type Address, createWalletClient, encodeErrorResult, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import { describe, expect, it } from "vitest";

const SENDER = "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01";
const ONE_HBAR = hbarToTinybar("1");
// 0.0.10574825 holds no SAUCE and has no automatic association slot; it has an EVM address of its own.
const UNASSOCIATED = "0x82756b984e8c34C28C98A3Eb6977dF106e4B3aaC";
const UNASSOCIATED_LONG_ZERO = "0x0000000000000000000000000000000000A15BE9";

async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the call to fail");
}

/** Simulates from SENDER a direct exactInput of 1 HBAR to `recipient`, as the captured eth_call did. */
async function simulateDirect(fixture: string, recipient: Address, value: bigint): Promise<unknown> {
  const client = replayClient([rpcFixture(fixture)]);
  return thrownBy(() =>
    client.simulateContract({
      address: testnet.swapRouter.evmAddress,
      abi: swapRouterAbi,
      functionName: "exactInput",
      args: [
        {
          path: swapPath(testnet.whbar, 3000, testnet.sauce),
          recipient,
          deadline: 1_790_091_643n,
          amountIn: ONE_HBAR,
          amountOutMinimum: 1n,
        },
      ],
      value,
      account: SENDER,
    }),
  );
}

function rpcErrorOf(fixture: string): unknown {
  return (rpcFixture(fixture).body as { error: unknown }).error;
}

describe("explainError before sending: simulation and estimation answers", () => {
  it("direct call to a recipient without the token: TransferFail(184) means associate", async () => {
    const failure = explainError(await simulateDirect("call-direct-unassociated-184", UNASSOCIATED, 10n ** 18n));
    expect(failure).toMatchObject({
      kind: "hts-response-code",
      code: 184,
      statusName: "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT",
      action: "associate",
    });
    expect(failure.via).toContain("TransferFail(184)");
  });

  it("the same through multicall: no revert data, the status name survives in the relay text only", () => {
    expect(explainError(rpcErrorOf("call-multicall-unassociated-184"))).toMatchObject({
      kind: "hedera-status-text",
      code: 184,
      action: "associate",
    });
  });

  it("a recipient in long-zero form of an account with its own EVM address: TransferFail(282)", async () => {
    const failure = explainError(
      await simulateDirect("call-direct-long-zero-recipient-282", UNASSOCIATED_LONG_ZERO, 10n ** 18n),
    );
    expect(failure).toMatchObject({ code: 282, statusName: "INVALID_ALIAS_KEY", action: "none" });
    expect(failure.message).toContain("evm_address");
  });

  it("'Too little received' means the price moved: requote", () => {
    expect(explainError(rpcErrorOf("call-too-little-received"))).toMatchObject({
      kind: "revert-string",
      action: "requote",
    });
  });

  it("a quote for a pool that does not exist reverts without data or status name", async () => {
    const client = replayClient([rpcFixture("call-quote-no-pool")]);
    const noPool = swapPath(testnet.whbar, 100, testnet.sauce);
    const failure = explainError(await thrownBy(() => quoteExactInput(client, noPool, ONE_HBAR)));
    expect(failure).toMatchObject({ kind: "empty-revert", action: "none" });
    expect(failure.message).toContain("simulate the inner exactInput call directly");
  });

  it("an unscaled value reads as INSUFFICIENT_TOKEN_BALANCE, which alone would advise funding the account", () => {
    expect(explainError(rpcErrorOf("estimate-multicall-unscaled-value"))).toMatchObject({
      statusName: "INSUFFICIENT_TOKEN_BALANCE",
      action: "fund",
    });
  });

  it("with the call's value and amountIn, the same answer is explained as the unit mistake it is", () => {
    const failure = explainError(rpcErrorOf("estimate-multicall-unscaled-value"), {
      value: assertJsonRpcValue(0n),
      amountIn: ONE_HBAR,
    });
    expect(failure).toMatchObject({ kind: "unscaled-value", action: "scale-value", code: 178 });
    expect(failure.message).toContain("pass amountIn × 10^10");
  });

  it("RespCode(178) on a direct call with a correct value stays a balance problem", async () => {
    const failure = explainError(await simulateDirect("call-direct-unscaled-value-178", SENDER, 10n ** 18n), {
      value: assertJsonRpcValue(10n ** 18n),
      amountIn: ONE_HBAR,
    });
    expect(failure).toMatchObject({ kind: "hts-response-code", code: 178, action: "fund" });
  });

  it("the relay's -32602 value precheck at send time: scale the value, quoting the relay", async () => {
    const wallet = createWalletClient({
      account: privateKeyToAccount(generatePrivateKey()),
      chain: hederaTestnet,
      transport: http(hederaTestnet.rpcUrls.default.http[0], {
        fetchFn: replayFetch([rpcFixture("chain-id"), rpcFixture("send-raw-value-below-one-tinybar")]),
        retryCount: 0,
      }),
    });
    const call = buildHbarToTokenSwap({
      pool: testnet.hbarSaucePool,
      recipient: SENDER,
      slippageBps: 500,
      deadline: 1_790_024_196n,
      amountIn: ONE_HBAR,
      quotedAmountOut: 46_434_742n,
    });
    const error = await thrownBy(() =>
      wallet.writeContract({
        ...call,
        value: 100_000_000n,
        gas: 300_000n,
        nonce: 0,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 0n,
      }),
    );
    const failure = explainError(error);
    expect(failure).toMatchObject({ kind: "relay-precheck", code: -32602, action: "scale-value" });
    expect(failure.message).toContain("Value can't be non-zero and less than 10_000_000_000 wei which is 1 tinybar");
    expect(failure.message).not.toContain("HTTP request failed");
  });

  it("an eth_getLogs span above 7 days", () => {
    const failure = explainError(rpcErrorOf("get-logs-span-over-7-days"));
    expect(failure).toMatchObject({ kind: "rpc-refusal", code: -32004, action: "none" });
    expect(failure.message).toContain("at most 7 days");
  });

  it("any other revert string is quoted, with no advice, even one named like an object property", () => {
    const data = encodeErrorResult({ abi: swapRevertAbi, errorName: "Error", args: ["toString"] });
    expect(explainError({ code: 3, message: "execution reverted: toString", data })).toMatchObject({
      kind: "revert-string",
      message: 'The contract refused the call: "toString".',
      action: "none",
    });
  });

  it("a selector this library does not know is reported by its selector", () => {
    const failure = explainError({
      code: 3,
      message: "execution reverted",
      data: "0xdeadbeef00000000000000000000000000000000000000000000000000000000000000b8",
    });
    expect(failure).toMatchObject({ kind: "unknown-revert", action: "none" });
    expect(failure.message).toContain("0xdeadbeef");
  });
});

describe("explainError on the library's own refusals and on transport failures", () => {
  it("a unit guard asks to scale the value", () => {
    const guard = new UnitError("value-below-one-tinybar", "below one tinybar");
    expect(explainError(guard)).toMatchObject({ kind: "refused-before-sending", action: "scale-value" });
  });

  it("a refused minimum output is not something to retry", async () => {
    const refusal = await thrownBy(async () => minimumOut(1n, 50));
    expect(refusal).toBeInstanceOf(SwapBuildError);
    expect(explainError(refusal)).toMatchObject({ kind: "refused-before-sending", action: "none" });
  });

  it("a mirror outage is retried, a mirror refusal is not", () => {
    expect(explainError(new MirrorError("unavailable", "/p", 503, "down")).action).toBe("retry");
    expect(explainError(new MirrorError("refused", "/p", 400, "bad")).action).toBe("none");
  });

  it.each([
    [{ code: -32005, message: "limit exceeded" }, "rate-limited", "retry"],
    [{ name: "HttpRequestError", status: 429, details: '"Too Many Requests"' }, "rate-limited", "retry"],
    [{ name: "HttpRequestError", details: "fetch failed" }, "unavailable", "retry"],
    [{ code: -32002, message: "The JSON-RPC upstream did not answer." }, "unavailable", "retry"],
    [{ code: 4001, message: "User rejected the request." }, "rejected-by-user", "none"],
    [{ code: -32601, message: "Method eth_fillTransaction not found" }, "rpc-refusal", "none"],
  ])("%j", (error, kind, action) => {
    expect(explainError(error)).toMatchObject({ kind, action });
  });

  it.each([undefined, null, "boom", new TypeError("x is not a function")])("never throws on %j", input => {
    expect(explainError(input).kind).toBe("unknown");
  });
});

describe("explainContractResult and postMortem after sending: the mirror node's view", () => {
  const hashOf = (fixture: string) => mirrorBody(fixture).hash as `0x${string}`;

  async function mirrorOf(result: string, actions?: string) {
    const answers = { [mirrorPaths.contractResult(hashOf(result))]: mirrorFixture(result) };
    if (actions !== undefined) answers[mirrorPaths.contractActions(hashOf(result))] = mirrorFixture(actions);
    const transport = replayMirror(answers);
    const mirror = createMirrorClient({ transport });
    const sent = await mirror.getContractResult(hashOf(result));
    if (sent === null) throw new Error(`fixture ${result} missing`);
    return { mirror, sent, transport };
  }

  it("the token -> HBAR swap without allowance (0x756b…dabc): 0x on chain, RespCode(292) in /actions", async () => {
    const { mirror, sent, transport } = await mirrorOf(
      "result-token-to-hbar-no-allowance-292",
      "actions-token-to-hbar-no-allowance-292",
    );
    expect(sent.errorMessage).toBe("0x");
    expect(await postMortem(mirror, sent)).toMatchObject({
      kind: "hts-response-code",
      code: 292,
      statusName: "SPENDER_DOES_NOT_HAVE_ALLOWANCE",
      action: "approve",
      via: "mirror actions, call depth 3: RespCode(292)",
    });
    expect(transport.requested).toContain(mirrorPaths.contractActions(sent.hash));
  });

  it("the swap above its allowance (0x2eed…223c): RespCode(293)", async () => {
    const { mirror, sent } = await mirrorOf(
      "result-token-to-hbar-allowance-too-small-293",
      "actions-token-to-hbar-allowance-too-small-293",
    );
    expect(await postMortem(mirror, sent)).toMatchObject({
      code: 293,
      statusName: "AMOUNT_EXCEEDS_ALLOWANCE",
      action: "approve",
    });
  });

  it("the multicall to a recipient without the token (0x4d10…a483): TransferFail(184) in /actions", async () => {
    const { mirror, sent } = await mirrorOf(
      "result-multicall-unassociated-recipient-184",
      "actions-multicall-unassociated-recipient-184",
    );
    expect(await postMortem(mirror, sent)).toMatchObject({ code: 184, action: "associate" });
  });

  it("the direct call (0xc0fb…976b) keeps its revert data, so no /actions request is made", async () => {
    const { mirror, sent, transport } = await mirrorOf("result-direct-unassociated-recipient-184");
    expect(await postMortem(mirror, sent)).toMatchObject({ code: 184, via: "mirror error_message: TransferFail(184)" });
    expect(transport.requested).toEqual([mirrorPaths.contractResult(sent.hash)]);
  });

  it("an empty revert without actions points to the mirror post-mortem", async () => {
    const { sent } = await mirrorOf("result-token-to-hbar-no-allowance-292");
    const failure = explainContractResult(sent);
    expect(failure).toMatchObject({ kind: "empty-revert", action: "none" });
    expect(failure?.message).toContain("/api/v1/contracts/results/{hash}/actions");
  });

  it("a successful swap has nothing to explain", async () => {
    const { mirror, sent } = await mirrorOf("result-token-to-hbar-success");
    expect(explainContractResult(sent)).toBeNull();
    expect(await postMortem(mirror, sent)).toBeNull();
  });
});

describe("explainResponseCode, for an HTS function that returned a code", () => {
  it("194: already associated, nothing to do", () => {
    expect(explainResponseCode(194, "associate()")).toMatchObject({
      statusName: "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT",
      action: "none",
    });
  });

  it("a code outside the table is still reported by its number", () => {
    const failure = explainResponseCode(7, "associate()");
    expect(failure.statusName).toBeNull();
    expect(failure.message).toBe("Hedera answered response code 7.");
  });
});

describe("an HBAR-input context never hides another failure", () => {
  it("leaves a non-balance failure unchanged", () => {
    const failure = explainError(rpcErrorOf("call-multicall-unassociated-184"), {
      value: assertJsonRpcValue(0n),
      amountIn: tinybar(1n),
    });
    expect(failure.statusName).toBe("TOKEN_NOT_ASSOCIATED_TO_ACCOUNT");
  });
});
