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

/**
 * An error a browser wallet handed back to the page, as the session report copied it. The MetaMask record of
 * 22 September carries only the sentence the wallet wrapped its refusal in; the HashPack record of 30 September
 * also carries the EIP-1193 code and the detail line, because that wallet answered with both.
 */
export type WalletErrorRecord = {
  readonly error: { readonly message: string; readonly code?: number; readonly details?: string };
};

export function walletFeeDisplay(): WalletFeeDisplay {
  return JSON.parse(readFileSync(fixtureUrl("wallet/metamask-fee-display"), "utf8")) as WalletFeeDisplay;
}

export function walletErrorRecord(name: string): WalletErrorRecord {
  return JSON.parse(readFileSync(fixtureUrl(`wallet/${name}`), "utf8")) as WalletErrorRecord;
}

export function mirrorFixture(name: string): MirrorResponse {
  return JSON.parse(readFileSync(fixtureUrl(`mirror/${name}`), "utf8")) as MirrorResponse;
}

/** One `Mint` or `Burn` of the HBAR/SAUCE pool, with the square-root price the pool was at when it happened. */
export type PoolEventFixture = {
  readonly event: "Mint" | "Burn";
  readonly transactionHash: string;
  readonly mirrorUrl: string;
  readonly blockNumber: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: string;
  readonly amount0: string;
  readonly amount1: string;
  readonly sqrtPriceX96Before: string;
  readonly tickBefore: number;
};

export type PoolEventsFixture = {
  readonly pool: {
    readonly fee: number;
    readonly tickSpacing: number;
    readonly token0: string;
    readonly token1: string;
  };
  readonly events: readonly PoolEventFixture[];
};

/** One transaction of the position life cycle this project executed, calldata included. */
export type LifecycleStepFixture = {
  readonly step: "mint" | "decrease" | "collect" | "burn";
  readonly transactionHash: string;
  readonly result: string;
  readonly valueTinybar: string;
  readonly gasLimit: number;
  readonly gasUsed: number;
  readonly functionParameters: `0x${string}`;
  readonly events: readonly { readonly name: string; readonly args: Record<string, string> }[];
};

export type LifecycleFixture = { readonly transactions: readonly LifecycleStepFixture[] };

export function positionFixture<T>(name: string): T {
  return JSON.parse(readFileSync(fixtureUrl(`position/${name}`), "utf8")) as T;
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
    const sameMethod = answers.filter(fixture => fixture.request.method === request.method);
    // Several captures of one method (the reads of a position are all eth_call) are told apart by their params;
    // with one capture the params are still compared below, so a test that sends something else still fails.
    const answer =
      sameMethod.find(fixture => canonicalParams(fixture.request.params) === canonicalParams(request.params)) ??
      sameMethod[0];
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
