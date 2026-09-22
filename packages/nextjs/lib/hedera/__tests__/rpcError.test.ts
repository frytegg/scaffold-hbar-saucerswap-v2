import { swapRouterAbi } from "../abi";
import { testnet } from "../addresses";
import { extractRpcError } from "../rpcError";
import { buildHbarToTokenSwap, swapPath } from "../swap";
import { hbarToTinybar } from "../units";
import { replayClient, replayFetch, rpcFixture } from "./replay";
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import { describe, expect, it } from "vitest";

const RPC_URL = hederaTestnet.rpcUrls.default.http[0];
const SENDER = "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01";
const PRECHECK_SENTENCE = "Value can't be non-zero and less than 10_000_000_000 wei which is 1 tinybar";

async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the call to fail");
}

/** The C05 mistake at send level: 1 HBAR of amountIn with a value of 10^8 weibar and an explicit gas limit. */
function unscaledSwap() {
  const swap = buildHbarToTokenSwap({
    pool: testnet.hbarSaucePool,
    recipient: SENDER,
    slippageBps: 500,
    deadline: 1_790_024_196n,
    amountIn: hbarToTinybar("1"),
    quotedAmountOut: 46_434_742n,
  });
  return {
    ...swap,
    value: 100_000_000n,
    gas: 300_000n,
    nonce: 0,
    maxFeePerGas: 1_368_000_000_000n,
    maxPriorityFeePerGas: 0n,
  };
}

async function sendThroughRelay(status?: number): Promise<unknown> {
  const wallet = createWalletClient({
    account: privateKeyToAccount(generatePrivateKey()),
    chain: hederaTestnet,
    transport: http(RPC_URL, {
      fetchFn: replayFetch([rpcFixture("chain-id"), rpcFixture("send-raw-value-below-one-tinybar")], status),
      retryCount: 0,
    }),
  });
  return thrownBy(() => wallet.writeContract(unscaledSwap()));
}

describe("extractRpcError on the errors viem 2.39.0 builds from the relay's real answers", () => {
  it("finds the -32602 value precheck inside a bare HttpRequestError whose shortMessage says nothing", async () => {
    const error = await sendThroughRelay();
    expect((error as { shortMessage?: string }).shortMessage).toBe("HTTP request failed.");
    expect(extractRpcError(error)).toEqual({
      code: -32602,
      message: PRECHECK_SENTENCE,
      data: null,
      httpStatus: 400,
      requestId: "9d422719-826a-4bdb-8393-82e79ad5cfa0",
      noAnswer: false,
    });
  });

  it("finds the same precheck when it comes through the app's relay route, which answers 200", async () => {
    const extracted = extractRpcError(await sendThroughRelay(200));
    expect(extracted.code).toBe(-32602);
    expect(extracted.message).toBe(PRECHECK_SENTENCE);
    expect(extracted.httpStatus).toBeNull();
  });

  it("finds -32004 in an eth_getLogs span above 7 days", async () => {
    const client = replayClient([rpcFixture("get-logs-span-over-7-days")]);
    const extracted = extractRpcError(
      await thrownBy(() => client.getLogs({ fromBlock: 40_422_225n, toBlock: 40_812_225n })),
    );
    expect(extracted.code).toBe(-32004);
    expect(extracted.httpStatus).toBe(400);
    expect(extracted.message).toMatch(/^The provided fromBlock and toBlock .* maximum allowed duration of 7 days/);
  });

  it("keeps the relay's status text of a revert without data; 2.39.0 keeps no code for it", async () => {
    const client = replayClient([rpcFixture("estimate-multicall-unscaled-value")]);
    const call = unscaledSwap();
    const error = await thrownBy(() =>
      client.estimateContractGas({
        address: call.address,
        abi: call.abi,
        functionName: "multicall",
        args: call.args,
        value: call.value,
        account: SENDER,
      }),
    );
    const extracted = extractRpcError(error);
    expect(extracted.data).toBe("0x");
    expect(extracted.message).toBe("execution reverted: CONTRACT_REVERT_EXECUTED, INSUFFICIENT_TOKEN_BALANCE");
    expect(extracted.code).toBeNull();
  });

  it("keeps the revert data of a custom error; 2.39.0 keeps none of the relay's text for it", async () => {
    const client = replayClient([rpcFixture("call-direct-unscaled-value-178")]);
    const error = await thrownBy(() =>
      client.simulateContract({
        address: testnet.swapRouter.evmAddress,
        abi: swapRouterAbi,
        functionName: "exactInput",
        args: [
          {
            path: swapPath(testnet.whbar, 3000, testnet.sauce),
            recipient: SENDER,
            deadline: 1_790_024_196n,
            amountIn: 100_000_000n,
            amountOutMinimum: 1n,
          },
        ],
        value: 100_000_000n,
        account: SENDER,
      }),
    );
    const extracted = extractRpcError(error);
    expect(extracted.data).toBe("0xffb9e6ed00000000000000000000000000000000000000000000000000000000000000b2");
    expect(extracted.message).toBeNull();
  });
});

describe("extractRpcError on other shapes", () => {
  it("reads a raw JSON-RPC error object", () => {
    const { error } = rpcFixture("call-too-little-received").body as { error: object };
    const extracted = extractRpcError(error);
    expect(extracted.code).toBe(3);
    expect(extracted.message).toBe("execution reverted: Too little received");
    expect(extracted.data).toMatch(/^0x08c379a0/);
  });

  it("reports a 429 without a JSON-RPC body by its HTTP status", async () => {
    const client = createPublicClient({
      chain: hederaTestnet,
      transport: http(RPC_URL, {
        fetchFn: async () => new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" }),
        retryCount: 0,
      }),
    });
    const extracted = extractRpcError(await thrownBy(() => client.getBlockNumber()));
    expect(extracted.httpStatus).toBe(429);
    expect(extracted.code).toBeNull();
  });

  it("marks a request that got no answer", async () => {
    const client = createPublicClient({
      chain: hederaTestnet,
      transport: http(RPC_URL, {
        fetchFn: async () => {
          throw new TypeError("fetch failed");
        },
        retryCount: 0,
      }),
    });
    const extracted = extractRpcError(await thrownBy(() => client.getBlockNumber()));
    expect(extracted.noAnswer).toBe(true);
    expect(extracted.code).toBeNull();
  });

  it("does not take the legacy numeric code of an aborted request for a JSON-RPC code", () => {
    const aborted = new Error("request aborted", {
      cause: new DOMException("The operation was aborted.", "AbortError"),
    });
    expect(extractRpcError(aborted).code).toBeNull();
  });

  it.each([undefined, null, "x", 42, {}])("returns nothing for %j", input => {
    expect(extractRpcError(input)).toEqual({
      code: null,
      message: null,
      data: null,
      httpStatus: null,
      requestId: null,
      noAnswer: false,
    });
  });

  it("parses nothing out of a non-JSON details string", () => {
    const error = { name: "HttpRequestError", status: 502, details: "Bad Gateway" };
    expect(extractRpcError(error)).toMatchObject({ code: null, httpStatus: 502, noAnswer: false });
  });
});
