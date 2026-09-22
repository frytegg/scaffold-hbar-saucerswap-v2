import type { MirrorResponse, MirrorTransport } from "../mirror";
import { readFileSync } from "node:fs";
import { type PublicClient, createPublicClient, http } from "viem";
import { hederaTestnet } from "viem/chains";

/** A JSON-RPC answer as the relay sent it: its HTTP status and body, and the request when the capture kept it. */
export type WireFixture = {
  request: { method: string; params?: readonly unknown[] };
  status: number;
  body: Record<string, unknown>;
};

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}.json`, import.meta.url);

export function rpcFixture(name: string): WireFixture {
  return JSON.parse(readFileSync(fixtureUrl(`rpc/${name}`), "utf8")) as WireFixture;
}

/**
 * The same capture, replayed for a read that names no sender. The captures were all made from 0x3b7a…6c01, reads
 * included; a quote or an allowance answers the same for any caller, and the library sends those reads without one.
 */
export function readFixture(name: string): WireFixture {
  const fixture = rpcFixture(name);
  const [call, ...rest] = fixture.request.params ?? [];
  const withoutSender = Object.fromEntries(
    Object.entries(call as Record<string, unknown>).filter(([key]) => key !== "from"),
  );
  return { ...fixture, request: { ...fixture.request, params: [withoutSender, ...rest] } };
}

/** What a browser wallet displayed for a transaction, next to what the mirror node says it cost. */
export type WalletFeeDisplay = {
  readonly gasPriceTinybarPerGas: number;
  readonly effectiveGasPriceTinybarPerGas: number;
  readonly rows: readonly {
    readonly label: string;
    readonly hash: string;
    readonly gasLimit: number;
    readonly gasUsed: number;
    readonly feeTinybar: number;
    readonly walletShownHbar: string;
  }[];
};

/** An error a browser wallet handed back to the page, as the session report copied it. */
export type WalletErrorRecord = { readonly error: { readonly message: string } };

export function walletFeeDisplay(): WalletFeeDisplay {
  return JSON.parse(readFileSync(fixtureUrl("wallet/metamask-fee-display"), "utf8")) as WalletFeeDisplay;
}

export function walletErrorRecord(name: string): WalletErrorRecord {
  return JSON.parse(readFileSync(fixtureUrl(`wallet/${name}`), "utf8")) as WalletErrorRecord;
}

export function mirrorFixture(name: string): MirrorResponse {
  return JSON.parse(readFileSync(fixtureUrl(`mirror/${name}`), "utf8")) as MirrorResponse;
}

/** The body of a captured mirror answer, for tests that read a field directly. */
export function mirrorBody(name: string): Record<string, unknown> {
  return mirrorFixture(name).body as Record<string, unknown>;
}

/**
 * JSON-RPC params as text, compared the way the relay reads them: fields in any order, hex in any case, and a zero
 * value as no value.
 */
function canonicalParams(params: readonly unknown[] | undefined): string {
  return JSON.stringify(params ?? [], (key, item: unknown) => {
    if (key === "value" && item === "0x0") return undefined;
    if (typeof item === "string" && item.startsWith("0x")) return item.toLowerCase();
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
    }
    return item;
  });
}

/**
 * A fetch for viem's http transport that answers each JSON-RPC method with its captured answer, so that the error
 * objects are the ones the pinned viem builds from the relay's real response. When the capture kept its request, the
 * test's request must be that same request: sender, target, calldata and value. Anything else fails the test.
 */
export function replayFetch(answers: readonly WireFixture[], status?: number): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    const answer = answers.find(fixture => fixture.request.method === request.method);
    if (answer === undefined) throw new Error(`No captured answer for ${request.method}.`);
    const captured = answer.request.params;
    if (captured !== undefined && canonicalParams(request.params) !== canonicalParams(captured)) {
      throw new Error(
        `The test sent ${request.method} ${canonicalParams(request.params)}, but the capture answered ` +
          `${canonicalParams(captured)}.`,
      );
    }
    return new Response(JSON.stringify({ ...answer.body, id: request.id }), {
      status: status ?? answer.status,
      headers: { "content-type": "application/json" },
    });
  };
}

/** A public client on Hedera testnet whose transport replays `answers`; `status` overrides every HTTP status. */
export function replayClient(answers: readonly WireFixture[], status?: number): PublicClient {
  return createPublicClient({
    chain: hederaTestnet,
    transport: http(hederaTestnet.rpcUrls.default.http[0], { fetchFn: replayFetch(answers, status), retryCount: 0 }),
  });
}

/** A mirror transport answering each path from `answers`, recording what was asked. */
export function replayMirror(answers: Record<string, MirrorResponse>): MirrorTransport & { requested: string[] } {
  const requested: string[] = [];
  const transport = async (path: string) => {
    requested.push(path);
    const answer = answers[path];
    if (answer === undefined) throw new Error(`No captured mirror answer for ${path}.`);
    return answer;
  };
  return Object.assign(transport, { requested });
}
