import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "~~/app/api/hedera/rpc/route";
import { type JsonRpcFailure, relayJsonRpc } from "~~/services/hedera/jsonRpcRelay";

const UPSTREAM = "https://testnet.hashio.io/api";
const TIMEOUT_MS = 1_000;
const call = (method: string, id: number | string = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params: [] });

const failureOf = (payload: unknown): JsonRpcFailure["error"] => (payload as JsonRpcFailure).error;

describe("relayJsonRpc answers in JSON-RPC whatever the upstream does", () => {
  it("refuses a body that is not JSON, without calling the upstream", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchFn);
    const { payload, upstreamFailure } = await relayJsonRpc("not json", UPSTREAM, TIMEOUT_MS);
    expect(failureOf(payload)).toMatchObject({ code: -32700, message: "The request body is not JSON." });
    expect(upstreamFailure).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([["42"], ["[]"], ['{"id":1}'], ['[{"method":"eth_chainId"},{"id":2}]']])(
    "refuses %s, which is not a JSON-RPC request",
    async body => {
      const { payload } = await relayJsonRpc(body, UPSTREAM, TIMEOUT_MS);
      expect(failureOf(payload).code).toBe(-32600);
    },
  );

  it("relays only the public eth, net and web3 namespaces", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchFn);
    const { payload } = await relayJsonRpc(call("debug_traceTransaction"), UPSTREAM, TIMEOUT_MS);
    expect(failureOf(payload)).toMatchObject({
      code: -32601,
      message: "The method debug_traceTransaction is not relayed.",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses the whole batch when one call of it is not relayed, keeping every id", async () => {
    const batch = `[${call("eth_chainId", 7)},${call("admin_peers", "abc")}]`;
    const { payload } = await relayJsonRpc(batch, UPSTREAM, TIMEOUT_MS);
    expect(payload).toMatchObject([{ id: 7, error: { code: -32601 } }, { id: "abc" }]);
  });

  // The reason this relay exists: hashio answers its own refusals with HTTP 400, and a browser logs any status of
  // 400 or more as a console error before the code can catch it. The JSON-RPC body has to survive that status.
  it("keeps the upstream's JSON-RPC error when it arrives on HTTP 400", async () => {
    const body = { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid parameter 0" } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body, { status: 400 })),
    );
    expect(await relayJsonRpc(call("eth_getBalance"), UPSTREAM, TIMEOUT_MS)).toEqual({
      payload: body,
      upstreamFailure: null,
    });
  });

  it("forwards the body it was given, unparsed, to the upstream URL", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ jsonrpc: "2.0", id: 1, result: "0x128" }));
    vi.stubGlobal("fetch", fetchFn);
    const body = call("eth_chainId");
    await relayJsonRpc(body, UPSTREAM, TIMEOUT_MS);
    expect(fetchFn.mock.calls[0][0]).toBe(UPSTREAM);
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ method: "POST", body });
  });

  it("writes a JSON-RPC error itself when the answer carries none, and says which status it was", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502</html>", { status: 502 })),
    );
    const { payload, upstreamFailure } = await relayJsonRpc(call("eth_chainId"), UPSTREAM, TIMEOUT_MS);
    expect(failureOf(payload)).toEqual({
      code: -32002,
      message: "The JSON-RPC upstream answered HTTP 502.",
      data: { upstreamStatus: 502 },
    });
    expect(upstreamFailure).toBe("HTTP 502 without a JSON-RPC body");
  });

  it("reports a rate limit with the code viem retries, not the one it gives up on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Too Many Requests", { status: 429 })),
    );
    const { payload } = await relayJsonRpc(call("eth_chainId"), UPSTREAM, TIMEOUT_MS);
    expect(failureOf(payload).code).toBe(-32005);
  });

  it("reports an upstream that did not answer, with the reason for the server log only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: new Error("ETIMEDOUT") });
      }),
    );
    const { payload, upstreamFailure } = await relayJsonRpc(call("eth_chainId"), UPSTREAM, TIMEOUT_MS);
    expect(failureOf(payload)).toEqual({
      code: -32002,
      message: "The JSON-RPC upstream did not answer.",
      data: { upstreamStatus: null },
    });
    expect(upstreamFailure).toBe("TypeError: fetch failed (ETIMEDOUT)");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});

describe("POST /api/hedera/rpc answers 200 in every case", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const post = async (query: string, body: string, headers: HeadersInit = {}) => {
    const response = await POST(
      new Request(`http://localhost:3000/api/hedera/rpc?${query}`, { method: "POST", body, headers }),
    );
    return { status: response.status, body: (await response.json()) as unknown };
  };

  it("with an unknown network", async () => {
    const { status, body } = await post("network=previewnet", call("eth_chainId"));
    expect(status).toBe(200);
    expect(failureOf(body)).toEqual({ code: -32600, message: 'Unknown Hedera network "previewnet".' });
  });

  it("with a body too large to be a signed transaction", async () => {
    const { status, body } = await post("network=testnet", call("eth_chainId"), { "content-length": "1000001" });
    expect(status).toBe(200);
    expect(failureOf(body)).toEqual({ code: -32600, message: "The request body is too large." });
  });

  it("passing the upstream's answer through", async () => {
    const answer = { jsonrpc: "2.0", id: 1, result: "0x128" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(answer)),
    );
    expect(await post("network=testnet", call("eth_chainId"))).toEqual({ status: 200, body: answer });
  });

  it("logging an upstream that did not answer, with no body in the log", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { status, body } = await post("network=testnet", call("eth_chainId"));
    expect(status).toBe(200);
    expect(failureOf(body).code).toBe(-32002);
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('"msg":"JSON-RPC upstream unavailable"');
    expect(line).toContain('"reason":"TypeError: fetch failed"');
  });
});
