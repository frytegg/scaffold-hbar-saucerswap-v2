import { testnet } from "../addresses";
import {
  MirrorError,
  type MirrorErrorReason,
  type MirrorResponse,
  type MirrorTransport,
  RETRY_DELAYS_MS,
  createMirrorClient,
  directMirrorTransport,
  sameOriginMirrorTransport,
} from "../mirror";
import { MIRROR_RELAY_ROUTE, mirrorPaths } from "../mirrorPaths";
import { mirrorBody, mirrorFixture, replayMirror } from "./replay";
import { describe, expect, it } from "vitest";

const N1 = mirrorBody("result-token-to-hbar-no-allowance-292").hash as `0x${string}`;
const SWAP_AT = "1790023842.760213408";
const MAIN = "0.0.10645914";

async function mirrorErrorOf(
  run: () => Promise<unknown>,
): Promise<{ reason: MirrorErrorReason; status: number | null }> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof MirrorError) return { reason: error.reason, status: error.status };
    throw error;
  }
  throw new Error("expected a MirrorError");
}

/** A transport that plays `script` in order, one entry per request: a response, or "no answer". */
function scripted(script: (MirrorResponse | "no answer")[]): { transport: MirrorTransport; calls: () => number } {
  let calls = 0;
  const transport: MirrorTransport = async path => {
    const next = script[calls++];
    if (next === undefined) throw new Error("the client asked more often than the script allows");
    if (next === "no answer") throw new MirrorError("unavailable", path, null, "no answer");
    return next;
  };
  return { transport, calls: () => calls };
}

function recordingSleep(): ((ms: number) => Promise<void>) & { waits: number[] } {
  const waits: number[] = [];
  return Object.assign(async (ms: number) => void waits.push(ms), { waits });
}

describe("the mirror client reads the captured payloads into typed results", () => {
  const mirror = createMirrorClient({
    transport: replayMirror({
      [mirrorPaths.contractResult(N1)]: mirrorFixture("result-token-to-hbar-no-allowance-292"),
      [mirrorPaths.contractActions(N1)]: mirrorFixture("actions-token-to-hbar-no-allowance-292"),
      [mirrorPaths.contractResult(`0x${"ab".repeat(32)}`)]: mirrorFixture("result-not-found"),
      [mirrorPaths.account(MAIN)]: mirrorFixture("account-unlimited-slots"),
      [mirrorPaths.account("0x0000000000000000000000000000000000a2719a")]:
        mirrorFixture("account-by-long-zero-address"),
      [mirrorPaths.account(`0x${"12".repeat(20)}`)]: mirrorFixture("account-not-found"),
      [mirrorPaths.tokenRelationship("0.0.10650085", testnet.sauce.id)]: mirrorFixture("tokens-relation-explicit"),
      [mirrorPaths.tokenRelationship(MAIN, testnet.sauce.id)]: mirrorFixture("tokens-relation-automatic"),
      [mirrorPaths.tokenRelationship("0.0.10574825", testnet.sauce.id)]: mirrorFixture("tokens-no-relation"),
      [mirrorPaths.tokenAllowance(MAIN, testnet.swapRouter.id, testnet.sauce.id)]:
        mirrorFixture("allowances-router-none"),
      [mirrorPaths.tokenAllowance(MAIN, "0.0.1308184", testnet.sauce.id)]: mirrorFixture("allowances-position-manager"),
      [mirrorPaths.nft(testnet.lpNft.id, "360")]: mirrorFixture("nft-serial-360-burnt"),
      [mirrorPaths.nft(testnet.lpNft.id, "358")]: mirrorFixture("nft-serial-358-held"),
      [mirrorPaths.nft(testnet.lpNft.id, "9999")]: mirrorFixture("nft-serial-not-found"),
      [mirrorPaths.transaction(SWAP_AT)]: mirrorFixture("transaction-token-to-hbar-success"),
      [mirrorPaths.transaction("1790023842.760213409")]: {
        status: 200,
        body: { transactions: [], links: { next: null } },
      },
    }),
  });

  it("a reverted contract result", async () => {
    expect(await mirror.getContractResult(N1)).toEqual({
      hash: N1,
      result: "CONTRACT_REVERT_EXECUTED",
      errorMessage: "0x",
      callResult: "0x",
      functionParameters: mirrorBody("result-token-to-hbar-no-allowance-292").function_parameters,
      from: "0x0000000000000000000000000000000000a2719a",
      gasUsed: 136_618n,
      amount: 0n,
      blockNumber: 40_812_405n,
      timestamp: mirrorBody("result-token-to-hbar-no-allowance-292").timestamp,
    });
  });

  it("null for a result the mirror does not have (404)", async () => {
    expect(await mirror.getContractResult(`0x${"ab".repeat(32)}`)).toBeNull();
  });

  it("one serial of a collection, burnt or held, and null for one the collection never had", async () => {
    expect(await mirror.getNft(testnet.lpNft.id, 360n)).toEqual({
      tokenId: testnet.lpNft.id,
      serialNumber: 360n,
      accountId: null,
      deleted: true,
      createdTimestamp: "1790110138.767890856",
      modifiedTimestamp: "1790110358.293712738",
    });
    expect(await mirror.getNft(testnet.lpNft.id, 358n)).toMatchObject({
      accountId: "0.0.10542434",
      deleted: false,
    });
    expect(await mirror.getNft(testnet.lpNft.id, 9999n)).toBeNull();
  });

  it("the call tree of that transaction", async () => {
    const actions = await mirror.getContractActions(N1);
    expect(actions).toHaveLength(12);
    expect(actions[10]).toEqual({
      callDepth: 3,
      resultDataType: "REVERT_REASON",
      resultData: "0xffb9e6ed0000000000000000000000000000000000000000000000000000000000000124",
    });
  });

  it("an account, by id and by its long-zero address, with its own EVM address either way", async () => {
    const expected = {
      accountId: MAIN,
      evmAddress: "0x3b7a9a1b874dd0994cc4137047dacf2803bb6c01",
      maxAutomaticTokenAssociations: -1,
      balance: 91_609_882_592n,
    };
    expect(await mirror.getAccount(MAIN)).toEqual(expected);
    expect(await mirror.getAccount("0x0000000000000000000000000000000000a2719a")).toEqual(expected);
  });

  it("null for an address with no account", async () => {
    expect(await mirror.getAccount(`0x${"12".repeat(20)}`)).toBeNull();
  });

  it("token relationships: explicit, automatic, none", async () => {
    expect(await mirror.getTokenRelationship("0.0.10650085", testnet.sauce.id)).toEqual({
      tokenId: testnet.sauce.id,
      automaticAssociation: false,
      balance: 46_466_682n,
    });
    expect((await mirror.getTokenRelationship(MAIN, testnet.sauce.id))?.automaticAssociation).toBe(true);
    expect(await mirror.getTokenRelationship("0.0.10574825", testnet.sauce.id)).toBeNull();
  });

  it("token allowances: the remaining amount, and 0 when the mirror has no row", async () => {
    expect(await mirror.getTokenAllowance(MAIN, "0.0.1308184", testnet.sauce.id)).toBe(40_000_000n);
    expect(await mirror.getTokenAllowance(MAIN, testnet.swapRouter.id, testnet.sauce.id)).toBe(0n);
  });

  it("the transaction record at a consensus timestamp, with its HBAR transfer list", async () => {
    expect(await mirror.getTransaction(SWAP_AT)).toEqual({
      transfers: [
        { account: "0.0.802", amount: 99_719_740n },
        { account: "0.0.15057", amount: -21_407_548n },
        { account: MAIN, amount: -78_312_192n },
      ],
    });
  });

  it("null for a timestamp with no transaction", async () => {
    expect(await mirror.getTransaction("1790023842.760213409")).toBeNull();
  });

  it("refuses a body without the fields it needs", async () => {
    const broken = createMirrorClient({ transport: async () => ({ status: 200, body: { result: "SUCCESS" } }) });
    expect(await mirrorErrorOf(() => broken.getContractResult(N1))).toEqual({ reason: "unexpected-body", status: 200 });
  });
});

describe("retries: 1, 2, 4 and 8 s on 429, 5xx or no answer; never on another 4xx", () => {
  const found = mirrorFixture("result-token-to-hbar-no-allowance-292");

  it("waits 1, 2 and 4 s through a 429, a 503 and a request without answer, then returns the result", async () => {
    const { transport } = scripted([{ status: 429, body: null }, { status: 503, body: null }, "no answer", found]);
    const sleep = recordingSleep();
    const result = await createMirrorClient({ transport, sleep }).getContractResult(N1);
    expect(result?.result).toBe("CONTRACT_REVERT_EXECUTED");
    expect(sleep.waits).toEqual([1_000, 2_000, 4_000]);
  });

  it("gives up after the 8 s wait: five attempts in all", async () => {
    const { transport, calls } = scripted(Array.from({ length: 5 }, () => ({ status: 502, body: null })));
    const sleep = recordingSleep();
    expect(await mirrorErrorOf(() => createMirrorClient({ transport, sleep }).getContractResult(N1))).toEqual({
      reason: "unavailable",
      status: 502,
    });
    expect(sleep.waits).toEqual([...RETRY_DELAYS_MS]);
    expect(calls()).toBe(5);
  });

  it("does not retry a 400", async () => {
    const { transport, calls } = scripted([
      { status: 400, body: { _status: { messages: [{ message: "Invalid parameter" }] } } },
    ]);
    const sleep = recordingSleep();
    expect(await mirrorErrorOf(() => createMirrorClient({ transport, sleep }).getAccount(MAIN))).toEqual({
      reason: "refused",
      status: 400,
    });
    expect(sleep.waits).toEqual([]);
    expect(calls()).toBe(1);
  });
});

describe("waitForResult polls until the mirror has ingested the transaction", () => {
  const notYet = mirrorFixture("result-not-found");

  it("returns the result once the 404s stop", async () => {
    const { transport } = scripted([notYet, notYet, mirrorFixture("result-token-to-hbar-success")]);
    const sleep = recordingSleep();
    const hash = mirrorBody("result-token-to-hbar-success").hash as `0x${string}`;
    const result = await createMirrorClient({ transport, sleep }).waitForResult(hash, { intervalMs: 500 });
    expect(result.result).toBe("SUCCESS");
    expect(sleep.waits).toEqual([500, 500]);
  });

  it("gives up with a typed error after polling at 0, 1, 2 and 3 s of a 3 s timeout", async () => {
    let clock = 0;
    const { transport, calls } = scripted(Array.from({ length: 10 }, () => notYet));
    const sleep = async (ms: number) => void (clock += ms);
    const mirror = createMirrorClient({ transport, sleep, now: () => clock });
    expect(await mirrorErrorOf(() => mirror.waitForResult(N1, { timeoutMs: 3_000, intervalMs: 1_000 }))).toEqual({
      reason: "timeout",
      status: 404,
    });
    expect(calls()).toBe(4);
  });
});

describe("transports", () => {
  it("the same-origin transport asks the app's relay and unwraps its envelope", async () => {
    const asked: string[] = [];
    const transport = sameOriginMirrorTransport(async input => {
      asked.push(String(input));
      return Response.json({ ok: true, status: 404, body: { _status: { messages: [{ message: "Not found" }] } } });
    });
    const path = mirrorPaths.contractResult(N1);
    expect(await transport(path)).toEqual({ status: 404, body: { _status: { messages: [{ message: "Not found" }] } } });
    expect(asked).toEqual([`${MIRROR_RELAY_ROUTE}?network=testnet&path=${encodeURIComponent(path)}`]);
  });

  it("a relay that could not reach the mirror is 'unavailable', so the client retries it", async () => {
    const transport = sameOriginMirrorTransport(async () =>
      Response.json({ ok: false, error: { code: "mirror_unavailable", message: "The mirror node did not answer." } }),
    );
    expect(await mirrorErrorOf(() => transport("/p"))).toEqual({ reason: "unavailable", status: null });
  });

  it("a path the relay refuses is 'refused'", async () => {
    const transport = sameOriginMirrorTransport(async () =>
      Response.json({ ok: false, error: { code: "invalid_path", message: "This mirror node path is not relayed." } }),
    );
    expect(await mirrorErrorOf(() => transport("/p"))).toEqual({ reason: "refused", status: null });
  });

  it("the direct transport joins the base URL and the path, and reports a network failure as 'unavailable'", async () => {
    const asked: string[] = [];
    const answering = directMirrorTransport("https://testnet.mirrornode.hedera.com", async input => {
      asked.push(String(input));
      return new Response("<html>bad gateway</html>", { status: 502 });
    });
    expect(await answering("/api/v1/accounts/0.0.2?transactions=false")).toEqual({ status: 502, body: null });
    expect(asked).toEqual(["https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.2?transactions=false"]);

    const failing = directMirrorTransport("https://testnet.mirrornode.hedera.com", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await mirrorErrorOf(() => failing("/p"))).toEqual({ reason: "unavailable", status: null });
  });
});
