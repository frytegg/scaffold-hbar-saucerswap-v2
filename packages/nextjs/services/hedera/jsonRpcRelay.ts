import { describeError } from "~~/services/hedera/serverLog";

export type JsonRpcId = string | number | null;

export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: { upstreamStatus: number | null } };
};

export type RelayOutcome = {
  /** A JSON-RPC response, or an array of them for a batch request. */
  payload: unknown;
  /** Why the upstream could not be used, for the server log; null when it answered in JSON-RPC. */
  upstreamFailure: string | null;
};

type JsonRpcCall = { id: JsonRpcId; method: string };

// JSON-RPC 2.0 and EIP-1474 codes. viem reports -32002 as "resource not available" without retrying,
// and retries -32005 ("limit exceeded") with a backoff.
const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
export const RESOURCE_UNAVAILABLE = -32002;
const LIMIT_EXCEEDED = -32005;

// The public Ethereum API only: node-management namespaces are never relayed.
const RELAYED_METHOD = /^(?:eth|net|web3)_[A-Za-z]+$/;

export function jsonRpcFailure(
  id: JsonRpcId,
  code: number,
  message: string,
  upstreamStatus?: number | null,
): JsonRpcFailure {
  const data = upstreamStatus === undefined ? {} : { data: { upstreamStatus } };
  return { jsonrpc: "2.0", id, error: { code, message, ...data } };
}

function readCall(value: unknown): JsonRpcCall | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, method } = value as { id?: unknown; method?: unknown };
  if (typeof method !== "string") return null;
  return { id: typeof id === "string" || typeof id === "number" ? id : null, method };
}

function readCalls(request: unknown): JsonRpcCall[] | null {
  const calls = (Array.isArray(request) ? request : [request]).map(readCall);
  return calls.length > 0 && calls.every(call => call !== null) ? calls : null;
}

function parseJsonRpcResponse(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // An HTML error page or an empty body: the caller reports the HTTP status instead.
    return null;
  }
  const isJsonRpc = Array.isArray(parsed) || (typeof parsed === "object" && parsed !== null && "jsonrpc" in parsed);
  return isJsonRpc ? parsed : null;
}

/**
 * Forwards a JSON-RPC request and always comes back with a JSON-RPC response.
 *
 * Public endpoints carry JSON-RPC errors, rate limits and outages on HTTP 4xx/5xx statuses, and a browser
 * logs every such status as a console error before any code can catch it. The relay keeps the upstream's
 * own JSON-RPC body whatever status carried it, and writes a JSON-RPC error itself when there is none,
 * so its route handler can answer 200 every time and the wallet stack sees an ordinary RPC error.
 */
export async function relayJsonRpc(rawBody: string, upstreamUrl: string, timeoutMs: number): Promise<RelayOutcome> {
  let request: unknown;
  try {
    request = JSON.parse(rawBody);
  } catch {
    return { payload: jsonRpcFailure(null, PARSE_ERROR, "The request body is not JSON."), upstreamFailure: null };
  }

  const calls = readCalls(request);
  if (calls === null) {
    return {
      payload: jsonRpcFailure(null, INVALID_REQUEST, "Expected a JSON-RPC request or a batch of them."),
      upstreamFailure: null,
    };
  }

  const failEveryCall = (code: number, message: string, upstreamStatus?: number | null) => {
    const failures = calls.map(call => jsonRpcFailure(call.id, code, message, upstreamStatus));
    return Array.isArray(request) ? failures : failures[0];
  };

  const refused = calls.find(call => !RELAYED_METHOD.test(call.method));
  if (refused) {
    return {
      payload: failEveryCall(METHOD_NOT_FOUND, `The method ${refused.method} is not relayed.`),
      upstreamFailure: null,
    };
  }

  let status: number;
  let text: string;
  try {
    const response = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawBody,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    text = await response.text();
  } catch (error: unknown) {
    return {
      payload: failEveryCall(RESOURCE_UNAVAILABLE, "The JSON-RPC upstream did not answer.", null),
      upstreamFailure: describeError(error),
    };
  }

  const upstreamPayload = parseJsonRpcResponse(text);
  if (upstreamPayload !== null) return { payload: upstreamPayload, upstreamFailure: null };

  const code = status === 429 ? LIMIT_EXCEEDED : RESOURCE_UNAVAILABLE;
  return {
    payload: failEveryCall(code, `The JSON-RPC upstream answered HTTP ${status}.`, status),
    upstreamFailure: `HTTP ${status} without a JSON-RPC body`,
  };
}
