import {
  assertBurnt,
  assertEmptied,
  assertPreflightPasses,
  collectFloor,
  hbarPaidByCollect,
  minimumsUnder,
  newSerial,
  offered,
  openedPosition,
  planDeposit,
  poolSides,
} from "../__live__/positionRun";
import { EvidenceRunRefusal } from "../__live__/runGuards";
import { testnet } from "../addresses";
import { amountsForLiquidity } from "../liquidityMath";
import type { PositionFields } from "../positionReads";
import type { PreflightVerdict } from "../preflight";
import { narrowRangeAround, sqrtRatioAtTick } from "../tickMath";
import { hbarToTinybar, tinybar } from "../units";
import { describe, expect, it } from "vitest";

// The decisions the signed position cycle makes before it signs, and the refusals that stop it. The price and the
// range are those of the position this project opened from a browser wallet on 22 Sept 2026 (serial 360): pool
// HBAR/SAUCE 0.30 %, tick -7643, spacing 60, which the chain answered 25,412,099 tinybar and 20 SAUCE for.

const pool = testnet.hbarSaucePool;
const TICK = -7643;
const SPACING = 60;
const range = narrowRangeAround(TICK, SPACING);
const sqrtPriceX96 = sqrtRatioAtTick(TICK);
const HBAR_TARGET = hbarToTinybar("0.1");
const HBAR_BUDGET = hbarToTinybar("0.2");
const TOKEN_BUDGET = 15_000_000n;

function refusalOf(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof EvidenceRunRefusal) return error.message;
    throw error;
  }
  throw new Error("expected an EvidenceRunRefusal");
}

const position = (fields: Partial<PositionFields>): PositionFields => ({
  tokenId: 360n,
  token0: testnet.whbar.evmAddress,
  token1: testnet.sauce.evmAddress,
  fee: pool.fee,
  tickLower: range.tickLower,
  tickUpper: range.tickUpper,
  liquidity: 0n,
  tokensOwed0: 0n,
  tokensOwed1: 0n,
  ...fields,
});

const verdict = (check: PreflightVerdict["check"], status: PreflightVerdict["status"]): PreflightVerdict => ({
  check,
  status,
  action: status === "fail" ? "approve" : "none",
  message: `${check} says ${status}`,
});

describe("the two sides of an HBAR pool", () => {
  it("puts HBAR where the pool's own token order puts it", () => {
    const { toPair, fromPair } = poolSides(pool);
    // WHBAR (0x…3aD2) sorts below SAUCE (0x…120f46), so HBAR is token0 of this pool.
    expect(toPair({ hbar: 7n, token: 11n })).toEqual({ amount0: 7n, amount1: 11n });
    expect(fromPair({ amount0: 7n, amount1: 11n })).toEqual({ hbar: 7n, token: 11n });
  });
});

describe("what the range needs", () => {
  it("buys with the HBAR target, and the token side follows the price", () => {
    const { liquidity, needed } = planDeposit({
      pool,
      sqrtPriceX96,
      range,
      hbarTarget: HBAR_TARGET,
      hbarBudget: HBAR_BUDGET,
      tokenBudget: TOKEN_BUDGET,
    });
    expect(needed.hbar).toBeLessThanOrEqual(HBAR_TARGET);
    expect(needed.token).toBeGreaterThan(0n);
    expect(needed.token).toBeLessThan(TOKEN_BUDGET);
    // The plan is what the liquidity maths says the pool will charge for that liquidity, to the unit.
    expect(amountsForLiquidity({ ...range, sqrtPriceX96, liquidity }, "deposit")).toEqual({
      amount0: needed.hbar,
      amount1: needed.token,
    });
  });

  it("refuses a deposit larger than the run is allowed to make", () => {
    expect(
      refusalOf(() =>
        planDeposit({
          pool,
          sqrtPriceX96,
          range,
          hbarTarget: HBAR_TARGET,
          hbarBudget: tinybar(1n),
          tokenBudget: TOKEN_BUDGET,
        }),
      ),
    ).toMatch(
      /would deposit .* over the 0\.00000001 HBAR and 15 SAUCE this run is allowed to put in\. Nothing was sent\./,
    );
  });

  it("offers more than the range needs and refuses less, both by a whole number of basis points", () => {
    const needed = { hbar: 1_000_000n, token: 2_000_000n };
    expect(offered(needed, 1_000)).toEqual({ hbar: 1_100_000n, token: 2_200_000n });
    expect(minimumsUnder(needed, pool, 1_000)).toEqual({ amount0Min: 900_000n, amount1Min: 1_800_000n });
    expect(refusalOf(() => offered(needed, 0))).toBe(
      "A margin of 0 basis points is not a whole number between 1 and 9999.",
    );
    expect(refusalOf(() => minimumsUnder(needed, pool, 10_000))).toBe(
      "A tolerance of 10000 basis points is not a whole number between 1 and 9999.",
    );
  });
});

describe("the serial the mint created", () => {
  it("is the one the account did not hold before", () => {
    expect(newSerial([359n], [359n, 360n])).toBe(360n);
    expect(newSerial([], [361n])).toBe(361n);
  });

  it.each([
    ["a mint that left no new serial", [359n], [359n], "none (1 serials before, 1 after)"],
    ["two serials at once", [], [360n, 361n], "360, 361 (0 serials before, 2 after)"],
  ])("refuses to guess after %s", (_what, before, after, listed) => {
    expect(refusalOf(() => newSerial(before, after))).toBe(
      `The mint should have left exactly one new position on the account, and the mirror node lists ${listed}. ` +
        "The cycle stops rather than close a position it cannot name.",
    );
  });
});

describe("the pre-flight", () => {
  it("lets a cycle start when nothing blocks it", () => {
    expect(() => assertPreflightPasses([verdict("cost", "pass"), verdict("minimums", "warn")], "mint")).not.toThrow();
  });

  it("refuses to start, naming every failing check and its action", () => {
    expect(
      refusalOf(() =>
        assertPreflightPasses([verdict("manager-allowance", "fail"), verdict("lp-nft-slot", "fail")], "mint"),
      ),
    ).toBe(
      "The pre-flight blocks this mint: manager-allowance (approve) — manager-allowance says fail " +
        "lp-nft-slot (approve) — lp-nft-slot says fail Nothing was sent.",
    );
  });
});

describe("the position at each step of the cycle", () => {
  it("refuses a serial the manager does not know, and one the mint left empty", () => {
    expect(refusalOf(() => openedPosition(null, 360n))).toBe(
      "The mirror node lists position 360 on the account, and the position manager does not know that serial. " +
        "Nothing more was sent.",
    );
    expect(refusalOf(() => openedPosition(position({ liquidity: 0n }), 360n))).toBe(
      "Position 360 was created with no liquidity: the mint deposited nothing.",
    );
    expect(openedPosition(position({ liquidity: 15_562_884_336n }), 360n).liquidity).toBe(15_562_884_336n);
  });

  it("refuses to collect a position the decrease did not empty", () => {
    expect(refusalOf(() => assertEmptied(position({ liquidity: 1n, tokensOwed0: 1n }), 360n))).toBe(
      "Position 360 still holds 1 of liquidity after the decrease, so the collect would leave part of it in the " +
        "pool. Nothing more was sent.",
    );
    expect(refusalOf(() => assertEmptied(position({}), 360n))).toBe(
      "Position 360 is owed nothing after the decrease: there would be nothing for the collect to pay out.",
    );
    expect(refusalOf(() => assertEmptied(null, 360n))).toBe(
      "The position manager no longer knows position 360, which the cycle just decreased.",
    );
  });

  it("refuses a burn that left the position behind", () => {
    expect(() => assertBurnt(null, [359n], 360n)).not.toThrow();
    expect(refusalOf(() => assertBurnt(position({}), [], 360n))).toBe(
      "The position manager still answers for position 360 after the burn.",
    );
    expect(refusalOf(() => assertBurnt(null, [360n], 360n))).toBe(
      "The mirror node still lists position 360 on the account after the burn.",
    );
  });
});

describe("the HBAR a collect pays", () => {
  // Position 360, closed from a browser wallet: the manager owed 25,412,098 tinybar and the account's own line in
  // the transaction record moved 24,443,613 while it paid 968,485 of fee.
  it("is what the account gained plus the fee it paid, and it equals what the position was owed", () => {
    expect(hbarPaidByCollect({ senderNetTinybar: -71_432_767n, feeTinybar: 96_844_865n, owed: 25_412_098n })).toEqual({
      paid: 25_412_098n,
      sweptFromManager: 0n,
    });
  });

  it("refuses a collect that paid the wrapped token instead: the account gained nothing but the fee", () => {
    expect(
      refusalOf(() =>
        hbarPaidByCollect({ senderNetTinybar: -96_844_865n, feeTinybar: 96_844_865n, owed: 25_412_098n }),
      ),
    ).toBe(
      "The collect moved 0 tinybar into the account while the position was owed 25412098: the HBAR side did not " +
        "arrive as HBAR. The three calls of the split collect are what unwraps it.",
    );
  });

  it("names, rather than refuses, wrapped HBAR the unwrap swept out of the manager", () => {
    // The 19,788,729 tinybar earlier callers had left in the manager on 21 Sept 2026, on top of what was owed.
    expect(hbarPaidByCollect({ senderNetTinybar: -51_644_038n, feeTinybar: 96_844_865n, owed: 25_412_098n })).toEqual({
      paid: 45_200_827n,
      sweptFromManager: 19_788_729n,
    });
  });
});

describe("the floor the collect's unwrap refuses to go under", () => {
  it("is what the position is owed on the HBAR side, the run's tolerance under it", () => {
    expect(collectFloor({ hbar: 25_412_098n, token: 20_000_000n }, 1_000)).toBe(22_870_888n);
  });

  it("refuses a tolerance that is not a whole number of basis points under one hundred per cent", () => {
    expect(refusalOf(() => collectFloor({ hbar: 25_412_098n, token: 0n }, 10_000))).toBe(
      "A tolerance of 10000 basis points is not a whole number between 1 and 9999.",
    );
  });
});
