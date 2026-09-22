import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "~~/app/api/hedera/account/route";
import type { AccountLookupResponse } from "~~/utils/scaffold-hbar/hederaAccountId";

const MAIN = "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01";

const get = async (query: string) => {
  const response = await GET(new Request(`http://localhost:3000/api/hedera/account?${query}`));
  return { status: response.status, body: (await response.json()) as AccountLookupResponse };
};

describe("GET /api/hedera/account answers 200 in every case", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([["network=testnet"], [`evm=0.0.10645914&network=testnet`], [`evm=${MAIN.slice(0, 20)}&network=testnet`]])(
    "refuses %s without asking the mirror node",
    async query => {
      const fetchFn = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchFn);
      expect(await get(query)).toEqual({
        status: 200,
        body: { ok: false, error: { code: "invalid_address", message: "Missing or invalid EVM address." } },
      });
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("refuses a network that is not Hedera's", async () => {
    expect(await get(`evm=${MAIN}&network=previewnet`)).toEqual({
      status: 200,
      body: { ok: false, error: { code: "invalid_network", message: 'Unknown Hedera network "previewnet".' } },
    });
  });

  it("defaults to testnet, and asks the mirror node for that address", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ account: "0.0.10645914" }));
    vi.stubGlobal("fetch", fetchFn);
    expect(await get(`evm=${MAIN}`)).toEqual({ status: 200, body: { ok: true, accountId: "0.0.10645914" } });
    expect(fetchFn.mock.calls[0][0]).toBe(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${MAIN}`);
  });

  // An address with no account yet is the normal state of a wallet that has never been funded on Hedera, not an error.
  it("answers no account, not a failure, when the mirror node says 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ _status: {} }, { status: 404 })),
    );
    expect(await get(`evm=${MAIN}&network=testnet`)).toEqual({ status: 200, body: { ok: true, accountId: null } });
  });

  it("answers no account when the mirror node answers a body without one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ balance: { balance: 0 } })),
    );
    expect(await get(`evm=${MAIN}&network=testnet`)).toEqual({ status: 200, body: { ok: true, accountId: null } });
  });

  it("reports a mirror node that refused, and logs the status without the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ _status: {} }, { status: 429 })),
    );
    const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await get(`evm=${MAIN}&network=testnet`)).toEqual({
      status: 200,
      body: { ok: false, error: { code: "mirror_unavailable", message: "The mirror node answered HTTP 429." } },
    });
    expect(String(log.mock.calls[0][0])).toContain('"msg":"Mirror node refused the lookup","network":"testnet"');
  });

  it("reports a mirror node that did not answer, with the reason for the server log", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
      }),
    );
    const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await get(`evm=${MAIN}&network=mainnet`)).toEqual({
      status: 200,
      body: { ok: false, error: { code: "mirror_unavailable", message: "The mirror node did not answer." } },
    });
    expect(String(log.mock.calls[0][0])).toContain('"reason":"TypeError: fetch failed (getaddrinfo ENOTFOUND)"');
  });
});
