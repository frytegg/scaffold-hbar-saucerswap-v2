import { NextResponse } from "next/server";
import { describeError, logServerEvent } from "~~/services/hedera/serverLog";
import { UpstreamConfigError, isHederaNetwork, mirrorNodeUrl } from "~~/services/hedera/upstreams";
import type { AccountLookupErrorCode, AccountLookupResponse } from "~~/utils/scaffold-hbar/hederaAccountId";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MIRROR_TIMEOUT_MS = 8_000;

function respond(body: AccountLookupResponse) {
  return NextResponse.json(body);
}

function fail(code: AccountLookupErrorCode, message: string) {
  return respond({ ok: false, error: { code, message } });
}

/** Resolves an EVM address to its Hedera account ID. Answers 200 in every case: see AccountLookupResponse. */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const evm = searchParams.get("evm");
  const network = (searchParams.get("network") ?? "testnet").toLowerCase();

  if (!evm || !EVM_ADDRESS_RE.test(evm)) return fail("invalid_address", "Missing or invalid EVM address.");
  if (!isHederaNetwork(network)) return fail("invalid_network", `Unknown Hedera network "${network}".`);

  let mirrorUrl: string;
  try {
    mirrorUrl = mirrorNodeUrl(network);
  } catch (error: unknown) {
    if (!(error instanceof UpstreamConfigError)) throw error;
    logServerEvent("error", "api:hedera:account", error.message, { network });
    return fail("misconfigured", "The mirror node URL is misconfigured: see the server log.");
  }

  try {
    const res = await fetch(`${mirrorUrl}/api/v1/accounts/${evm}`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
    });

    if (res.status === 404) return respond({ ok: true, accountId: null });
    if (!res.ok) {
      logServerEvent("warn", "api:hedera:account", "Mirror node refused the lookup", { network, status: res.status });
      return fail("mirror_unavailable", `The mirror node answered HTTP ${res.status}.`);
    }

    const data = (await res.json()) as { account?: unknown };
    return respond({ ok: true, accountId: typeof data.account === "string" ? data.account : null });
  } catch (error: unknown) {
    logServerEvent("warn", "api:hedera:account", "Mirror node did not answer", {
      network,
      reason: describeError(error),
    });
    return fail("mirror_unavailable", "The mirror node did not answer.");
  }
}
