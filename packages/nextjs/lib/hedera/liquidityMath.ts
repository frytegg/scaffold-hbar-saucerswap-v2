import { Q96, type TickRange, assertRange, sqrtRatioAtTick } from "./tickMath";

// What a range of ticks costs and what it holds, from the same published formulas as `tickMath.ts` and with no line
// of SaucerSwap's or Uniswap's copyleft sources: between two square-root prices a position holds
// `amount0 = L x (1/sqrtLower - 1/sqrtUpper)` of token0 and `amount1 = L x (sqrtUpper - sqrtLower)` of token1, in
// Q64.96 arithmetic. The direction of every division is the part that matters on chain: a pool charges a deposit
// rounded up and pays a withdrawal rounded down, so the two are separate modes here and the tests check each
// against amounts Hedera testnet reported.

/** Which way the divisions round: what a mint is charged, or what a close pays out. */
export type AmountRounding = "deposit" | "withdraw";

export type PositionAmounts = { readonly amount0: bigint; readonly amount1: bigint };

/** Where a pool's price sits relative to a range, and therefore what the position is made of. */
export type PositionRange =
  /** Below the range: the position is token0 alone and earns no fee. */
  | "below"
  /** Inside it: both tokens, and the position earns fees. */
  | "in-range"
  /** At or above it: token1 alone, no fee. */
  | "above";

export type LiquidityMathErrorCode = "negative-amount" | "no-amount";

export class LiquidityMathError extends Error {
  readonly code: LiquidityMathErrorCode;

  constructor(code: LiquidityMathErrorCode, message: string) {
    super(message);
    this.name = "LiquidityMathError";
    this.code = code;
  }
}

const divideRoundingUp = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator;

function assertNotNegative(value: bigint, what: string): bigint {
  if (value < 0n) throw new LiquidityMathError("negative-amount", `${what} is ${value}, which is negative.`);
  return value;
}

function orderedRatios(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint): readonly [bigint, bigint] {
  return sqrtRatioAX96 <= sqrtRatioBX96 ? [sqrtRatioAX96, sqrtRatioBX96] : [sqrtRatioBX96, sqrtRatioAX96];
}

/**
 * The token0 a liquidity of `liquidity` spans between two square-root prices. Both divisions round the same way,
 * which is what makes a deposit land on the pool's own figure rather than one unit under it.
 */
export function amount0Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  rounding: AmountRounding,
): bigint {
  const [low, high] = orderedRatios(sqrtRatioAX96, sqrtRatioBX96);
  const numerator = assertNotNegative(liquidity, "A liquidity") * (high - low) * Q96;
  return rounding === "deposit" ? divideRoundingUp(divideRoundingUp(numerator, high), low) : numerator / high / low;
}

/** The token1 that same liquidity spans between the two prices. */
export function amount1Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  rounding: AmountRounding,
): bigint {
  const [low, high] = orderedRatios(sqrtRatioAX96, sqrtRatioBX96);
  const numerator = assertNotNegative(liquidity, "A liquidity") * (high - low);
  return rounding === "deposit" ? divideRoundingUp(numerator, Q96) : numerator / Q96;
}

export type PositionAt = TickRange & {
  /** The pool's live square root price, as `slot0` reports it. */
  readonly sqrtPriceX96: bigint;
};

/**
 * The two amounts a range holds at the live price: what a mint of this much liquidity must deposit
 * (`rounding: "deposit"`), or what closing it would pay out (`rounding: "withdraw"`). Outside the range one of the
 * two is zero, which is the whole point of a range order and the case a UI must show before the wallet opens.
 */
export function amountsForLiquidity(
  position: PositionAt & { readonly liquidity: bigint },
  rounding: AmountRounding,
): PositionAmounts {
  const { sqrtPriceX96, liquidity } = position;
  const { tickLower, tickUpper } = assertRange(position);
  const sqrtLower = sqrtRatioAtTick(tickLower);
  const sqrtUpper = sqrtRatioAtTick(tickUpper);
  if (sqrtPriceX96 <= sqrtLower) {
    return { amount0: amount0Delta(sqrtLower, sqrtUpper, liquidity, rounding), amount1: 0n };
  }
  if (sqrtPriceX96 >= sqrtUpper) {
    return { amount0: 0n, amount1: amount1Delta(sqrtLower, sqrtUpper, liquidity, rounding) };
  }
  return {
    amount0: amount0Delta(sqrtPriceX96, sqrtUpper, liquidity, rounding),
    amount1: amount1Delta(sqrtLower, sqrtPriceX96, liquidity, rounding),
  };
}

/**
 * The liquidity a pair of amounts buys at the live price, rounded down: the side that runs out first decides, and
 * the other side is left partly unspent, which is why a mint quotes `amount0Min` and `amount1Min` below what it
 * offers. Feeding the amounts of a real mint back through this function returns at least the liquidity it created.
 */
export function liquidityForAmounts(position: PositionAt & PositionAmounts): bigint {
  const { sqrtPriceX96, amount0, amount1 } = position;
  const { tickLower, tickUpper } = assertRange(position);
  assertNotNegative(amount0, "An amount of token0");
  assertNotNegative(amount1, "An amount of token1");
  if (amount0 === 0n && amount1 === 0n) {
    throw new LiquidityMathError("no-amount", "A position needs an amount of at least one of the two tokens.");
  }
  const sqrtLower = sqrtRatioAtTick(tickLower);
  const sqrtUpper = sqrtRatioAtTick(tickUpper);
  const fromAmount0 = (low: bigint, high: bigint): bigint => (amount0 * ((low * high) / Q96)) / (high - low);
  const fromAmount1 = (low: bigint, high: bigint): bigint => (amount1 * Q96) / (high - low);
  if (sqrtPriceX96 <= sqrtLower) return fromAmount0(sqrtLower, sqrtUpper);
  if (sqrtPriceX96 >= sqrtUpper) return fromAmount1(sqrtLower, sqrtUpper);
  const byToken0 = fromAmount0(sqrtPriceX96, sqrtUpper);
  const byToken1 = fromAmount1(sqrtLower, sqrtPriceX96);
  return byToken0 < byToken1 ? byToken0 : byToken1;
}

/**
 * Whether the pool's live tick leaves the position earning fees. It reads the tick rather than the square-root
 * price because that is the boundary a pool itself uses: a price exactly on the lower tick is still in range, and
 * one on the upper tick is not.
 */
export function rangeOfPosition(position: TickRange & { readonly tick: number }): PositionRange {
  const { tickLower, tickUpper } = assertRange(position);
  if (position.tick < tickLower) return "below";
  if (position.tick >= tickUpper) return "above";
  return "in-range";
}
