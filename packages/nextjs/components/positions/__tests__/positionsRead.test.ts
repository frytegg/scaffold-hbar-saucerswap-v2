import { type PositionsReads, isPositionOfPool, readPositions } from "../positionsRead";
import { describe, expect, it } from "vitest";
import { MIRROR_UNAVAILABLE } from "~~/components/hedera/failureText";
import {
  type EvmAddress,
  MirrorError,
  type PoolState,
  type PositionFields,
  sqrtRatioAtTick,
  testnet,
} from "~~/lib/hedera";

// Every state this route can show, with the reads replaced: no network, no key, and the sentences asserted are the
// library's own. The position is serial 360, which this project opened and closed from a browser wallet on
// 22 September 2026, and the pool stands at the tick it reported at the block before that mint.

const ACCOUNT: EvmAddress = "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01";
const POOL = testnet.hbarSaucePool;
/** The price is the library's own square root of tick -7643; the pool's total liquidity is asserted nowhere here. */
const POOL_STATE: PoolState = {
  sqrtPriceX96: sqrtRatioAtTick(-7_643),
  tick: -7_643,
  tickSpacing: 60,
  liquidity: 0n,
};

function position(patch: Partial<PositionFields> = {}): PositionFields {
  return {
    tokenId: 360n,
    token0: testnet.whbar.evmAddress,
    token1: testnet.sauce.evmAddress,
    fee: 3_000,
    tickLower: -7_680,
    tickUpper: -7_620,
    liquidity: 15_562_884_336n,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
    ...patch,
  };
}

function reads(overrides: Partial<PositionsReads> = {}): { reads: PositionsReads; inFlight: number[] } {
  const inFlight: number[] = [];
  let running = 0;
  return {
    inFlight,
    reads: {
      serials: overrides.serials ?? (() => Promise.resolve({ serials: [360n], hasMore: false })),
      pool: overrides.pool ?? (() => Promise.resolve(POOL_STATE)),
      position: async serial => {
        running += 1;
        inFlight.push(running);
        try {
          return overrides.position === undefined ? position({ tokenId: serial }) : await overrides.position(serial);
        } finally {
          running -= 1;
        }
      },
    },
  };
}

const input = (fake: PositionsReads) => ({ reads: fake, account: ACCOUNT, pool: POOL, now: 1_700_000_000_000 });

describe("a list that cannot be read at all", () => {
  it("stops at the mirror node, because without the serials there is nothing to show", async () => {
    const { reads: fake } = reads({
      serials: () => Promise.reject(new MirrorError("unavailable", "/api/v1/accounts", null, "no answer")),
    });
    const result = await readPositions(input(fake));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.headline).toBe(MIRROR_UNAVAILABLE);
    expect(result.failure.kind).toBe("unavailable");
  });

  it("is not a failure when the account simply holds none", async () => {
    const { reads: fake } = reads({ serials: () => Promise.resolve({ serials: [], hasMore: false }) });
    const result = await readPositions(input(fake));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([]);
    expect(result.poolFailure).toBeNull();
  });

  it("says when the mirror node has more serials than the one page this route reads", async () => {
    const { reads: fake } = reads({ serials: () => Promise.resolve({ serials: [360n], hasMore: true }) });
    const result = await readPositions(input(fake));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hasMore).toBe(true);
  });
});

describe("one serial at a time", () => {
  it("prices a position against the live pool, and says what closing it returns", async () => {
    const { reads: fake } = reads({
      position: serial => Promise.resolve(position({ tokenId: serial, tokensOwed1: 1_000_000n })),
    });
    const result = await readPositions(input(fake));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [entry] = result.entries;
    expect(entry.state).toBe("open");
    if (entry.state !== "open") return;
    expect(entry.status.range).toBe("in-range");
    expect(entry.status.closeReturns.amount1).toBe(entry.status.principal.amount1 + 1_000_000n);
    expect(entry.status.closeReturns.amount0).toBe(entry.status.principal.amount0);
  });

  it("reads a burnt serial as closed, because the manager reverts instead of answering an empty struct", async () => {
    const { reads: fake } = reads({ position: () => Promise.resolve(null) });
    const result = await readPositions(input(fake));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0].state).toBe("closed");
  });

  it("keeps a serial that got no answer, with the library's own sentence, instead of dropping it", async () => {
    const { reads: fake } = reads({
      position: () => Promise.reject(new MirrorError("unavailable", "/api/v1/contracts/call", null, "no answer")),
    });
    const result = await readPositions(input(fake));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [entry] = result.entries;
    expect(entry.state).toBe("unreadable");
    if (entry.state !== "unreadable") return;
    expect(entry.failure.kind).toBe("unavailable");
  });

  it("leaves a position of another pool unpriced, and names the pool it is in", async () => {
    const { reads: fake } = reads({ position: serial => Promise.resolve(position({ tokenId: serial, fee: 500 })) });
    const result = await readPositions(input(fake));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [entry] = result.entries;
    expect(entry.state).toBe("unpriced");
    if (entry.state !== "unpriced") return;
    expect(entry.reason).toContain("fee 500");
    expect(entry.reason).toContain("The address book of this template holds one pool");
  });
});

describe("a pool that did not answer", () => {
  it("still lists every serial, unpriced and carrying why", async () => {
    const { reads: fake } = reads({
      serials: () => Promise.resolve({ serials: [359n, 360n], hasMore: false }),
      pool: () => Promise.reject(new MirrorError("unavailable", "/api/v1/contracts/call", null, "no answer")),
    });
    const result = await readPositions(input(fake));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pool).toBeNull();
    expect(result.poolFailure?.kind).toBe("unavailable");
    expect(result.entries.map(entry => entry.state)).toEqual(["unpriced", "unpriced"]);
    const [entry] = result.entries;
    if (entry.state !== "unpriced") return;
    expect(entry.reason).toContain("what closing it returns is unknown");
  });
});

describe("reading a page of serials", () => {
  it("never has more than five reads in flight, because the relay's own rate limit is not published", async () => {
    const serials = Array.from({ length: 12 }, (_, index) => BigInt(400 + index));
    const { reads: fake, inFlight } = reads({
      serials: () => Promise.resolve({ serials, hasMore: false }),
      position: serial => Promise.resolve(position({ tokenId: serial })),
    });
    const result = await readPositions(input(fake));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(12);
    expect(Math.max(...inFlight)).toBeLessThanOrEqual(5);
  });
});

describe("which pool a serial belongs to", () => {
  it("matches on both tokens and the fee, which is all a serial carries about its pool", () => {
    expect(isPositionOfPool(position(), POOL)).toBe(true);
    expect(isPositionOfPool(position({ fee: 500 }), POOL)).toBe(false);
    expect(isPositionOfPool(position({ token1: testnet.whbar.evmAddress }), POOL)).toBe(false);
  });

  it("does not depend on the case an address arrives in", () => {
    const lowercased = testnet.whbar.evmAddress.toLowerCase() as EvmAddress;
    expect(isPositionOfPool(position({ token0: lowercased }), POOL)).toBe(true);
  });
});
