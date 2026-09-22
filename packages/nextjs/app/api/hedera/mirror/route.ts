import { NextResponse } from "next/server";
import type { MirrorRelayResponse } from "~~/lib/hedera/mirrorPaths";
import { relayMirrorGet } from "~~/services/hedera/mirrorRelay";
import { logServerEvent } from "~~/services/hedera/serverLog";
import { UpstreamConfigError, isHederaNetwork, mirrorNodeUrl } from "~~/services/hedera/upstreams";

const MIRROR_TIMEOUT_MS = 8_000;

function respond(payload: MirrorRelayResponse) {
  return NextResponse.json(payload);
}

/**
 * Same-origin GET relay to the mirror node for the browser, GET /api/hedera/mirror?network=testnet&path=/api/v1/…
 * Only the paths of lib/hedera's mirror client are forwarded. It answers 200 every time: see relayMirrorGet.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const network = params.get("network");
  if (!isHederaNetwork(network)) {
    return respond({ ok: false, error: { code: "invalid_network", message: `Unknown Hedera network "${network}".` } });
  }

  let mirrorUrl: string;
  try {
    mirrorUrl = mirrorNodeUrl(network);
  } catch (error: unknown) {
    if (!(error instanceof UpstreamConfigError)) throw error;
    logServerEvent("error", "api:hedera:mirror", error.message, { network });
    return respond({
      ok: false,
      error: { code: "misconfigured", message: "The mirror node URL is misconfigured: see the server log." },
    });
  }

  const { payload, upstreamFailure } = await relayMirrorGet(params.get("path") ?? "", mirrorUrl, MIRROR_TIMEOUT_MS);
  if (upstreamFailure !== null) {
    logServerEvent("warn", "api:hedera:mirror", "Mirror node unavailable", { network, reason: upstreamFailure });
  } else if (payload.ok && (payload.status === 429 || payload.status >= 500)) {
    logServerEvent("warn", "api:hedera:mirror", "Mirror node refused the request", { network, status: payload.status });
  }
  return respond(payload);
}
