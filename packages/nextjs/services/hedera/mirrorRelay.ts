import { readJsonBody } from "~~/lib/hedera/mirror";
import { type MirrorRelayResponse, isRelayedMirrorPath } from "~~/lib/hedera/mirrorPaths";
import { describeError } from "~~/services/hedera/serverLog";

export type MirrorRelayOutcome = {
  payload: MirrorRelayResponse;
  /** Why the mirror node could not be reached, for the server log; null when it answered. */
  upstreamFailure: string | null;
};

/**
 * Forwards one GET that the library's mirror client needs and wraps whatever came back, so that the route handler
 * answers 200 every time: the browser then logs nothing when the mirror answers 404 (a result not ingested yet),
 * 429 or 5xx, and the client reads the mirror's own status from the payload.
 */
export async function relayMirrorGet(
  path: string,
  mirrorUrl: string,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<MirrorRelayOutcome> {
  if (!isRelayedMirrorPath(path)) {
    return {
      payload: { ok: false, error: { code: "invalid_path", message: "This mirror node path is not relayed." } },
      upstreamFailure: null,
    };
  }

  try {
    const response = await fetchFn(`${mirrorUrl}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      payload: { ok: true, status: response.status, body: await readJsonBody(response) },
      upstreamFailure: null,
    };
  } catch (error: unknown) {
    return {
      payload: { ok: false, error: { code: "mirror_unavailable", message: "The mirror node did not answer." } },
      upstreamFailure: describeError(error),
    };
  }
}
