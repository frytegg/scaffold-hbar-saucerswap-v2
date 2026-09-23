import {
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  Q96,
  TickMathError,
  assertRange,
  narrowRangeAround,
  snapRangeToSpacing,
  snapTickDown,
  snapTickUp,
  sqrtRatioAtTick,
  tickAtSqrtRatio,
} from "../tickMath";
import { type PoolEventsFixture, positionFixture } from "./replay";
import { describe, expect, it } from "vitest";

const pool = positionFixture<PoolEventsFixture>("hbar-sauce-pool-events");

describe("the square root of the price at a tick", () => {
  it("is the fixed-point unit at tick 0, where the price is 1", () => {
    expect(sqrtRatioAtTick(0)).toBe(Q96);
  });

  it("agrees with the tick every one of the pool's own prices was reported at", () => {
    for (const event of pool.events) {
      expect(tickAtSqrtRatio(BigInt(event.sqrtPriceX96Before))).toBe(event.tickBefore);
    }
  });

  it("reads back the tick it was given, at both ends of the range and in between", () => {
    for (const tick of [MIN_TICK, -12000, -7643, -7620, -1, 0, 1, 60, 46031, MAX_TICK]) {
      expect(tickAtSqrtRatio(sqrtRatioAtTick(tick))).toBe(tick);
    }
  });

  it("rises with the tick, one step at a time", () => {
    for (let tick = -7700; tick < -7600; tick++) {
      expect(sqrtRatioAtTick(tick)).toBeLessThan(sqrtRatioAtTick(tick + 1));
    }
  });

  it("names the widest tick a pool can hold: the next one no longer fits 160 bits", () => {
    const uint160 = 1n << 160n;
    expect(sqrtRatioAtTick(MAX_TICK)).toBeLessThan(uint160);
    // One tick higher multiplies the square root by the square root of 1.0001, so compare the squares: the bound is
    // what makes 887272 the last tick, and the function refuses to be asked for 887273 at all.
    expect(MAX_SQRT_RATIO * MAX_SQRT_RATIO * 10_001n).toBeGreaterThan(uint160 * uint160 * 10_000n);
    expect(() => sqrtRatioAtTick(MAX_TICK + 1)).toThrow(TickMathError);
    expect(MIN_TICK).toBe(-MAX_TICK);
    expect(MIN_SQRT_RATIO).toBe(sqrtRatioAtTick(MIN_TICK));
    expect(MAX_SQRT_RATIO).toBe(sqrtRatioAtTick(MAX_TICK));
  });

  it("refuses a tick outside that range, and a price outside what a pool can hold", () => {
    expect(() => sqrtRatioAtTick(MAX_TICK + 1)).toThrow(TickMathError);
    expect(() => sqrtRatioAtTick(MIN_TICK - 1)).toThrow(/between -887272 and 887272/);
    expect(() => sqrtRatioAtTick(1.5)).toThrow(/not an integer/);
    expect(() => tickAtSqrtRatio(MIN_SQRT_RATIO - 1n)).toThrow(TickMathError);
    expect(() => tickAtSqrtRatio(MAX_SQRT_RATIO + 1n)).toThrow(/outside the range a pool can hold/);
  });
});

describe("snapping a range to a pool's tick spacing", () => {
  it("gives the range this project's own positions were opened over, from the tick the pool was at", () => {
    expect(narrowRangeAround(-7643, pool.pool.tickSpacing)).toEqual({ tickLower: -7680, tickUpper: -7620 });
    expect(narrowRangeAround(-7640, pool.pool.tickSpacing)).toEqual({ tickLower: -7680, tickUpper: -7620 });
  });

  it("rounds a negative tick away from zero downwards, which a truncating division would not", () => {
    expect(snapTickDown(-7643, 60)).toBe(-7680);
    expect(snapTickUp(-7643, 60)).toBe(-7620);
    expect(snapTickDown(-7620, 60)).toBe(-7620);
    expect(snapTickUp(-7620, 60)).toBe(-7620);
    expect(snapTickDown(61, 60)).toBe(60);
    expect(snapTickUp(61, 60)).toBe(120);
  });

  it("widens a range outwards so that nothing the caller asked for is left out", () => {
    expect(snapRangeToSpacing({ tickLower: -7650, tickUpper: -7630 }, 60)).toEqual({
      tickLower: -7680,
      tickUpper: -7620,
    });
  });

  it("leaves a range already on the spacing alone, including the widest one in the fixture", () => {
    const widest = pool.events.find(event => event.tickLower === -887220);
    if (widest === undefined) throw new Error("the fixture holds a full-range position");
    const range = { tickLower: widest.tickLower, tickUpper: widest.tickUpper };
    expect(snapRangeToSpacing(range, pool.pool.tickSpacing)).toEqual(range);
  });

  it("refuses a spacing that is not a positive whole number, and a range a pool cannot hold", () => {
    expect(() => snapTickDown(0, 0)).toThrow(/not a positive integer/);
    expect(() => snapTickUp(0, -60)).toThrow(TickMathError);
    expect(() => assertRange({ tickLower: -60, tickUpper: -60 })).toThrow(/is empty/);
    expect(() => assertRange({ tickLower: MIN_TICK - 60, tickUpper: 0 })).toThrow(/leaves the ticks a pool can hold/);
    expect(() => narrowRangeAround(MAX_TICK, 60)).toThrow(TickMathError);
  });
});
