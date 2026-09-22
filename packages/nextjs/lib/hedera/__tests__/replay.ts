import type { MirrorResponse, MirrorTransport } from "../mirror";
import { readFileSync } from "node:fs";
import { type PublicClient, createPublicClient, http } from "viem";
import { hederaTestnet } from "viem/chains";

/** A JSON-RPC answer as the relay sent it: its HTTP status and body. */
export type WireFixture = { request: { method: string }; status: number; body: Record<string, unknown> };

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}.json`, import.meta.url);

export function rpcFixture(name: string): WireFixture {
  return JSON.parse(readFileSync(fixtureUrl(`rpc/${name}`), "utf8")) as WireFixture;
}

export function mirrorFixture(name: string): MirrorResponse {
  return JSON.parse(readFileSync(fixtureUrl(`mirror/${name}`), "utf8")) as MirrorResponse;
}

/** The body of a captured mirror answer, for tests that read a field directly. */
export function mirrorBody(name: string): Record<string, unknown> {
  return mirrorFixture(name).body as Record<string, unknown>;
}

/**
 * A fetch for viem's http transport that answers each JSON-RPC method with its captured answer, so that the error
 * objects are the ones the pinned viem builds from the relay's real response. Any other method fails the test.
 */
export function replayFetch(answers: readonly WireFixture[], status?: number): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    const answer = answers.find(fixture => fixture.request.method === request.method);
    if (answer === undefined) throw new Error(`No captured answer for ${request.method}.`);
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
