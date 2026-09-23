// Tick maths for a concentrated-liquidity pool, written here from the published formulas. A tick `t` names the
// price 1.0001^t of token1 in token0, and a pool keeps the square root of that price as a Q64.96 fixed-point
// number. SaucerSwap's and Uniswap's own libraries are GPL-2.0-or-later and BUSL-1.1, so no line and no magic
// constant of theirs is used: `sqrtRatioAtTick` raises 1.0001 to the tick in 256-bit fixed point and takes an
// integer square root, and `tickAtSqrtRatio` inverts it by bisection over that same function. The bounds below are
// derived, and `__tests__/tickMath.test.ts` checks the output against ticks and prices Hedera testnet reported.

export type TickMathErrorCode = "tick-out-of-range" | "sqrt-ratio-out-of-range" | "spacing-not-positive";

export class TickMathError extends Error {
  readonly code: TickMathErrorCode;

  constructor(code: TickMathErrorCode, message: string) {
    super(message);
    this.name = "TickMathError";
    this.code = code;
  }
}

/** A price of 1 in Q64.96: the fixed-point unit a pool's `sqrtPriceX96` is written in. */
export const Q96 = 1n << 96n;

/**
 * The widest tick a pool can hold: above it the square root of the price no longer fits the 160 bits a pool stores
 * it in. `1.0001^(887272/2) x 2^96` is under 2^160 and `1.0001^(887273/2) x 2^96` is over it, which the tests check.
 */
export const MAX_TICK = 887272;
export const MIN_TICK = -MAX_TICK;

// 1.0001 and the working precision of the exponentiation. Each multiplication truncates one unit in the last place
// of 2^-256, and raising to a tick takes at most 40 of them, so the relative error stays near 2^-250 while the
// coarsest answer this function gives, at MIN_TICK, is about 2^32: the truncation never reaches the result.
const PRECISION_BITS = 256n;
const ONE = 1n << PRECISION_BITS;
const TICK_BASE = (10_001n << PRECISION_BITS) / 10_000n;

function powFixed(base: bigint, exponent: bigint): bigint {
  let result = ONE;
  let factor = base;
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining & 1n) result = (result * factor) >> PRECISION_BITS;
    factor = (factor * factor) >> PRECISION_BITS;
    remaining >>= 1n;
  }
  return result;
}

/** The largest integer whose square is at most `value`, by Newton's method from an upper first guess. */
function integerSquareRoot(value: bigint): bigint {
  if (value < 2n) return value;
  let guess = 1n << (BigInt(value.toString(2).length) / 2n + 1n);
  for (;;) {
    const next = (guess + value / guess) >> 1n;
    if (next >= guess) return guess;
    guess = next;
  }
}

/**
 * The square root of the price at `tick`, as the Q64.96 number a pool stores, rounded down. A pool's own value can
 * differ by a few units in the last place, because its library approximates the same formula differently; the
 * amounts computed from either agree to the unit, which is what the oracle tests assert.
 */
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new TickMathError("tick-out-of-range", `Tick ${tick} is not an integer between ${MIN_TICK} and ${MAX_TICK}.`);
  }
  const power = powFixed(TICK_BASE, BigInt(Math.abs(tick)));
  const ratio = tick < 0 ? (ONE * ONE) / power : power;
  // ratio is the price in Q256; its square root in Q96 is the square root of the price shifted by 256 - 2 x 96.
  return integerSquareRoot(ratio >> (PRECISION_BITS - 192n));
}

/** The narrowest price a pool can hold, and the widest: the square roots at the two extreme ticks. */
export const MIN_SQRT_RATIO = sqrtRatioAtTick(MIN_TICK);
export const MAX_SQRT_RATIO = sqrtRatioAtTick(MAX_TICK);

/**
 * The tick a `sqrtPriceX96` sits in: the largest tick whose square root is at or below it, which is what a pool
 * reports as its current tick. Found by bisection over `sqrtRatioAtTick`, so the two functions cannot drift apart.
 */
export function tickAtSqrtRatio(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 > MAX_SQRT_RATIO) {
    throw new TickMathError(
      "sqrt-ratio-out-of-range",
      `A square-root price of ${sqrtPriceX96} is outside the range a pool can hold, ` +
        `${MIN_SQRT_RATIO} to ${MAX_SQRT_RATIO}.`,
    );
  }
  let low = MIN_TICK;
  let high = MAX_TICK;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (sqrtRatioAtTick(middle) <= sqrtPriceX96) low = middle;
    else high = middle - 1;
  }
  return low;
}

function assertSpacing(tickSpacing: number): void {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new TickMathError("spacing-not-positive", `A tick spacing of ${tickSpacing} is not a positive integer.`);
  }
}

/** The largest multiple of `tickSpacing` at or below `tick`: a pool accepts no other lower bound. */
export function snapTickDown(tick: number, tickSpacing: number): number {
  assertSpacing(tickSpacing);
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

/** The smallest multiple of `tickSpacing` at or above `tick`. */
export function snapTickUp(tick: number, tickSpacing: number): number {
  assertSpacing(tickSpacing);
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

export type TickRange = { readonly tickLower: number; readonly tickUpper: number };

/**
 * The narrowest range a pool accepts around `tick`: the spacing step it sits in. On the HBAR/SAUCE 0.30 % pool,
 * whose spacing is 60, tick -7643 gives [-7680, -7620], the range this project's own positions were opened over.
 */
export function narrowRangeAround(tick: number, tickSpacing: number): TickRange {
  const tickLower = snapTickDown(tick, tickSpacing);
  return assertRange({ tickLower, tickUpper: tickLower + tickSpacing });
}

/** The same range widened outwards to the spacing, so that nothing the caller asked for is left out of it. */
export function snapRangeToSpacing(range: TickRange, tickSpacing: number): TickRange {
  return assertRange({
    tickLower: snapTickDown(range.tickLower, tickSpacing),
    tickUpper: snapTickUp(range.tickUpper, tickSpacing),
  });
}

/** Refuses a range a pool cannot hold: outside the tick bounds, or empty. */
export function assertRange(range: TickRange): TickRange {
  const { tickLower, tickUpper } = range;
  if (tickLower < MIN_TICK || tickUpper > MAX_TICK) {
    throw new TickMathError(
      "tick-out-of-range",
      `The range [${tickLower}, ${tickUpper}] leaves the ticks a pool can hold, ${MIN_TICK} to ${MAX_TICK}.`,
    );
  }
  if (tickLower >= tickUpper) {
    throw new TickMathError(
      "tick-out-of-range",
      `The range [${tickLower}, ${tickUpper}] is empty: its lower tick must be below its upper tick.`,
    );
  }
  return range;
}
