import { type Hex, isHex } from "viem";

/** What the JSON-RPC relay itself said, whatever shape the viem version wrapped it in. */
export type RpcErrorDetails = {
  /** The JSON-RPC error code: 3 for a revert, -32602 for the relay's value precheck, and so on. */
  code: number | null;
  /** The relay's own message, without its "[Request ID: …]" prefix. Never viem's `shortMessage`. */
  message: string | null;
  /** Revert data; "0x" when the call reverted without data. */
  data: Hex | null;
  httpStatus: number | null;
  requestId: string | null;
  /** The request got no answer at all: a network failure or viem's own timeout. */
  noAnswer: boolean;
};

type ErrorLevel = {
  name?: unknown;
  code?: unknown;
  details?: unknown;
  message?: unknown;
  data?: unknown;
  raw?: unknown;
  reason?: unknown;
  status?: unknown;
  cause?: unknown;
};

const MAX_DEPTH = 12;
const REQUEST_ID = /^\[Request ID: ([^\]]+)\]\s*/;

function asLevel(value: unknown): ErrorLevel | null {
  return typeof value === "object" && value !== null ? (value as ErrorLevel) : null;
}

/** A JSON-RPC code, as opposed to the numeric legacy `code` a DOMException such as an abort also carries. */
function rpcCodeOf(level: ErrorLevel): number | null {
  if (typeof level.code !== "number" || level instanceof DOMException) return null;
  return level.code;
}

/** viem 2.39.0 carries the body of a non-2xx answer only as a JSON string in `HttpRequestError.details`. */
function parseHttpDetails(details: string): { code: number; message: string | null; data: unknown } | null {
  if (!details.startsWith("{")) return null;
  try {
    const body = asLevel(JSON.parse(details));
    if (body === null || typeof body.code !== "number") return null;
    return { code: body.code, message: typeof body.message === "string" ? body.message : null, data: body.data };
  } catch {
    // The status text of a proxy, not a JSON-RPC body: the HTTP status still says what happened.
    return null;
  }
}

function asRevertData(value: unknown): Hex | null {
  return typeof value === "string" && isHex(value) ? value : null;
}

/**
 * Walks an error's cause chain and returns what the relay said. Works on viem 2.39.0 (the pinned version: a relay
 * refusal is a bare HttpRequestError, a revert keeps only `raw` and `reason`), on later viem versions (typed errors
 * with a numeric code), on errors that came through this app's same-origin relay (always HTTP 200), and on a raw
 * JSON-RPC error object.
 */
export function extractRpcError(error: unknown): RpcErrorDetails {
  const found: RpcErrorDetails = {
    code: null,
    message: null,
    data: null,
    httpStatus: null,
    requestId: null,
    noAnswer: false,
  };
  let level = asLevel(error);

  for (let depth = 0; level !== null && depth < MAX_DEPTH; depth++) {
    if (found.httpStatus === null && typeof level.status === "number") found.httpStatus = level.status;

    const code = rpcCodeOf(level);
    if (found.code === null && code !== null) {
      found.code = code;
      if (typeof level.details === "string") found.message = level.details;
      else if (typeof level.message === "string") found.message = level.message;
    }

    if (level.name === "HttpRequestError") {
      if (typeof level.status !== "number") found.noAnswer = true;
      else if (found.code === null && typeof level.details === "string") {
        const body = parseHttpDetails(level.details);
        if (body !== null) {
          found.code = body.code;
          found.message = body.message;
          found.data = asRevertData(body.data) ?? found.data;
        }
      }
    }
    if (level.name === "TimeoutError") found.noAnswer = true;

    const data = asRevertData(level.raw) ?? asRevertData(level.data);
    if (data !== null && (found.data === null || found.data === "0x")) found.data = data;

    if (found.message === null && typeof level.reason === "string") found.message = level.reason;

    level = asLevel(level.cause);
  }

  if (found.message !== null) {
    const prefix = REQUEST_ID.exec(found.message);
    if (prefix !== null) {
      found.requestId = prefix[1];
      found.message = found.message.slice(prefix[0].length);
    }
  }
  return found;
}
