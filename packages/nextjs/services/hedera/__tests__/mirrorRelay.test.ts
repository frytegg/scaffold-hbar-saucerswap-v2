import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "~~/app/api/hedera/mirror/route";
import { testnet } from "~~/lib/hedera/addresses";
import { isRelayedMirrorPath, mirrorPaths } from "~~/lib/hedera/mirrorPaths";
import { relayMirrorGet } from "~~/services/hedera/mirrorRelay";

const MIRROR = "https://testnet.mirrornode.hedera.com";
const HASH = `0x${"ab".repeat(32)}` as const;

describe("the relay forwards exactly the paths the mirror client builds", () => {
  it.each([
    mirrorPaths.contractResult(HASH),
    mirrorPaths.contractActions(HASH),
    mirrorPaths.account("0.0.10645914"),
    mirrorPaths.account("0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01"),
    mirrorPaths.tokenRelationship("0.0.10645914", testnet.sauce.id),
    mirrorPaths.tokenAllowance("0.0.10645914", testnet.swapRouter.id, testnet.sauce.id),
    mirrorPaths.transaction("1790023842.760213408"),
  ])("forwards %s", path => {
    expect(isRelayedMirrorPath(path)).toBe(true);
  });

  it.each([
    "",
    "/api/v1/accounts/0.0.2/nfts",
    "/api/v1/contracts/results/0x12",
    "/api/v1/accounts/0.0.2?transactions=true",
    "/api/v1/accounts/0.0.2?transactions=false&limit=100",
    "https://example.com/api/v1/accounts/0.0.2?transactions=false",
    "/api/v1/accounts/../network/nodes?transactions=false",
    "/api/v1/transactions?timestamp=gt:1790023842.760213408",
    "/api/v1/transactions?account.id=0.0.2",
  ])("refuses %j", path => {
    expect(isRelayedMirrorPath(path)).toBe(false);
  });
});

describe("relayMirrorGet", () => {
  it("refuses a path outside the list without calling the mirror", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const { payload } = await relayMirrorGet("/api/v1/network/nodes", MIRROR, 1_000, fetchFn);
    expect(payload).toEqual({
      ok: false,
      error: { code: "invalid_path", message: "This mirror node path is not relayed." },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("wraps the mirror's own status and body, a 404 included", async () => {
    const notFound = { _status: { messages: [{ message: "Not found" }] } };
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(notFound, { status: 404 }));
    const path = mirrorPaths.contractResult(HASH);
    expect(await relayMirrorGet(path, MIRROR, 1_000, fetchFn)).toEqual({
      payload: { ok: true, status: 404, body: notFound },
      upstreamFailure: null,
    });
    expect(fetchFn.mock.calls[0][0]).toBe(`${MIRROR}${path}`);
  });

  it("keeps a 502 whose body is an HTML page, with no body", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("<html>502</html>", { status: 502 }));
    const { payload } = await relayMirrorGet(mirrorPaths.contractResult(HASH), MIRROR, 1_000, fetchFn);
    expect(payload).toEqual({ ok: true, status: 502, body: null });
  });

  it("reports an unreachable mirror, with the reason for the server log", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
    });
    expect(await relayMirrorGet(mirrorPaths.contractResult(HASH), MIRROR, 1_000, fetchFn)).toEqual({
      payload: { ok: false, error: { code: "mirror_unavailable", message: "The mirror node did not answer." } },
      upstreamFailure: "TypeError: fetch failed (getaddrinfo ENOTFOUND)",
    });
  });
});

describe("GET /api/hedera/mirror answers 200 in every case", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const get = async (query: string) => {
    const response = await GET(new Request(`http://localhost:3000/api/hedera/mirror?${query}`));
    return { status: response.status, body: await response.json() };
  };

  it("without a path", async () => {
    expect(await get("network=testnet")).toEqual({
      status: 200,
      body: { ok: false, error: { code: "invalid_path", message: "This mirror node path is not relayed." } },
    });
  });

  it("with an unknown network", async () => {
    expect(await get("network=previewnet")).toEqual({
      status: 200,
      body: { ok: false, error: { code: "invalid_network", message: 'Unknown Hedera network "previewnet".' } },
    });
  });

  it("when the mirror answers 429, logging it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ _status: { messages: [{ message: "Too Many Requests" }] } }, { status: 429 })),
    );
    const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const path = encodeURIComponent(mirrorPaths.account("0.0.10645914"));
    const { status, body } = await get(`network=testnet&path=${path}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: 429 });
    expect(String(log.mock.calls[0][0])).toContain('"msg":"Mirror node refused the request"');
  });
});
