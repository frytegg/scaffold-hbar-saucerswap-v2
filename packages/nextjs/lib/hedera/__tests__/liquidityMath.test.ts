import { LiquidityMathError, amountsForLiquidity, liquidityForAmounts, rangeOfPosition } from "../liquidityMath";
import { type PoolEventFixture, type PoolEventsFixture, positionFixture } from "./replay";
import { describe, expect, it } from "vitest";

// Every expectation below is an amount the HBAR/SAUCE 0.30 % pool itself reported, next to the square-root price it
// was at when it did. The fixture's note says where each row came from; nothing here is a figure this library
// computed for itself.

const pool = positionFixture<PoolEventsFixture>("hbar-sauce-pool-events");
const at = (event: PoolEventFixture) => ({
  sqrtPriceX96: BigInt(event.sqrtPriceX96Before),
  tickLower: event.tickLower,
  tickUpper: event.tickUpper,
  liquidity: BigInt(event.liquidity),
});
const label = (event: PoolEventFixture) =>
  `${event.event} [${event.tickLower}, ${event.tickUpper}] at tick ${event.tickBefore}, ${event.transactionHash.slice(0, 10)}`;

const mints = pool.events.filter(event => event.event === "Mint");
const burns = pool.events.filter(event => event.event === "Burn");
const ourMint = pool.events.find(event => event.liquidity === "15562884336" && event.event === "Mint");
const ourBurn = pool.events.find(event => event.liquidity === "15562884336" && event.event === "Burn");

describe("the amounts a range needs, against what the pool charged", () => {
  it.each(mints.map(event => [label(event), event] as const))(
    "a deposit lands on the pool's own figure: %s",
    (_name, event) => {
      expect(amountsForLiquidity(at(event), "deposit")).toEqual({
        amount0: BigInt(event.amount0),
        amount1: BigInt(event.amount1),
      });
    },
  );

  it.each(burns.map(event => [label(event), event] as const))(
    "a withdrawal lands on the pool's own figure: %s",
    (_name, event) => {
      expect(amountsForLiquidity(at(event), "withdraw")).toEqual({
        amount0: BigInt(event.amount0),
        amount1: BigInt(event.amount1),
      });
    },
  );

  it("rounds a deposit up and a withdrawal down, which is why the two are separate", () => {
    if (ourMint === undefined || ourBurn === undefined) throw new Error("the fixture holds both sides of serial 360");
    const deposited = amountsForLiquidity(at(ourMint), "deposit");
    const withdrawn = amountsForLiquidity(at(ourBurn), "withdraw");
    expect(deposited.amount0 - withdrawn.amount0).toBe(1n);
    expect(deposited.amount1 - withdrawn.amount1).toBe(1n);
  });

  it("holds one token alone outside the range, and the fixture has a case of each", () => {
    const tokenOneOnly = pool.events.filter(event => event.amount0 === "0");
    const tokenZeroOnly = pool.events.filter(event => event.amount1 === "0");
    expect(tokenOneOnly.length).toBeGreaterThan(0);
    expect(tokenZeroOnly.length).toBeGreaterThan(0);
    for (const event of tokenOneOnly) {
      expect(event.tickUpper).toBeLessThanOrEqual(event.tickBefore);
      expect(amountsForLiquidity(at(event), event.event === "Mint" ? "deposit" : "withdraw").amount0).toBe(0n);
    }
    for (const event of tokenZeroOnly) {
      expect(event.tickLower).toBeGreaterThan(event.tickBefore);
      expect(amountsForLiquidity(at(event), event.event === "Mint" ? "deposit" : "withdraw").amount1).toBe(0n);
    }
  });
});

describe("the liquidity a pair of amounts buys", () => {
  it.each(mints.map(event => [label(event), event] as const))(
    "is never more than the pool created from them: %s",
    (_name, event) => {
      const bought = liquidityForAmounts({
        sqrtPriceX96: BigInt(event.sqrtPriceX96Before),
        tickLower: event.tickLower,
        tickUpper: event.tickUpper,
        amount0: BigInt(event.amount0),
        amount1: BigInt(event.amount1),
      });
      expect(bought).toBeGreaterThanOrEqual(BigInt(event.liquidity));
    },
  );

  it("returns the pool's own liquidity for the two positions this project opened", () => {
    for (const event of mints.filter(row => row.liquidity === "15562884336" || row.liquidity === "43860633182")) {
      expect(
        liquidityForAmounts({
          sqrtPriceX96: BigInt(event.sqrtPriceX96Before),
          tickLower: event.tickLower,
          tickUpper: event.tickUpper,
          amount0: BigInt(event.amount0),
          amount1: BigInt(event.amount1),
        }),
      ).toBe(BigInt(event.liquidity));
    }
  });

  it("refuses amounts that are negative or both zero, and a range a pool cannot hold", () => {
    const range = { sqrtPriceX96: 1n << 96n, tickLower: -60, tickUpper: 60 };
    expect(() => liquidityForAmounts({ ...range, amount0: 0n, amount1: 0n })).toThrow(LiquidityMathError);
    expect(() => liquidityForAmounts({ ...range, amount0: -1n, amount1: 1n })).toThrow(/is negative/);
    expect(() => liquidityForAmounts({ ...range, tickLower: 60, tickUpper: -60, amount0: 1n, amount1: 1n })).toThrow(
      /is empty/,
    );
    expect(() =>
      amountsForLiquidity({ sqrtPriceX96: 1n << 96n, tickLower: -60, tickUpper: 60, liquidity: -1n }, "deposit"),
    ).toThrow(/is negative/);
  });
});

describe("where the price leaves a position", () => {
  it("answers what the pool's own tick says for each event in the fixture", () => {
    for (const event of pool.events) {
      const verdict = rangeOfPosition({
        tick: event.tickBefore,
        tickLower: event.tickLower,
        tickUpper: event.tickUpper,
      });
      const expected = event.amount0 === "0" ? "above" : event.amount1 === "0" ? "below" : "in-range";
      expect(verdict, label(event)).toBe(expected);
    }
  });

  it("counts the lower tick as inside the range and the upper tick as outside, as a pool does", () => {
    const range = { tickLower: -7680, tickUpper: -7620 };
    expect(rangeOfPosition({ ...range, tick: -7681 })).toBe("below");
    expect(rangeOfPosition({ ...range, tick: -7680 })).toBe("in-range");
    expect(rangeOfPosition({ ...range, tick: -7621 })).toBe("in-range");
    expect(rangeOfPosition({ ...range, tick: -7620 })).toBe("above");
  });
});
