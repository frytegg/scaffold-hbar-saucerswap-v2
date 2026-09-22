import { NextResponse } from "next/server";
import { INVALID_REQUEST, RESOURCE_UNAVAILABLE, jsonRpcFailure, relayJsonRpc } from "~~/services/hedera/jsonRpcRelay";
import { logServerEvent } from "~~/services/hedera/serverLog";
import { UpstreamConfigError, isHederaNetwork, jsonRpcUrl } from "~~/services/hedera/upstreams";

// Below the 10 s after which viem abandons a request, so the browser gets the relay's answer, not a timeout.
const UPSTREAM_TIMEOUT_MS = 8_000;
// A signed contract deployment is the largest legitimate body, and it stays far below this.
const MAX_BODY_BYTES = 1_000_000;

/**
 * Same-origin JSON-RPC endpoint of the browser's wallet stack, POST /api/hedera/rpc?network=testnet|mainnet.
 * It answers 200 every time, with a JSON-RPC error body when something failed: see relayJsonRpc.
 */
export async function POST(request: Request) {
  const network = new URL(request.url).searchParams.get("network");
  if (!isHederaNetwork(network)) {
    return NextResponse.json(jsonRpcFailure(null, INVALID_REQUEST, `Unknown Hedera network "${network}".`));
  }
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    return NextResponse.json(jsonRpcFailure(null, INVALID_REQUEST, "The request body is too large."));
  }

  let upstreamUrl: string;
  try {
    upstreamUrl = jsonRpcUrl(network);
  } catch (error: unknown) {
    if (!(error instanceof UpstreamConfigError)) throw error;
    logServerEvent("error", "api:hedera:rpc", error.message, { network });
    return NextResponse.json(
      jsonRpcFailure(null, RESOURCE_UNAVAILABLE, "The JSON-RPC relay is misconfigured: see the server log."),
    );
  }

  const { payload, upstreamFailure } = await relayJsonRpc(await request.text(), upstreamUrl, UPSTREAM_TIMEOUT_MS);
  if (upstreamFailure !== null) {
    logServerEvent("warn", "api:hedera:rpc", "JSON-RPC upstream unavailable", { network, reason: upstreamFailure });
  }
  return NextResponse.json(payload);
}
