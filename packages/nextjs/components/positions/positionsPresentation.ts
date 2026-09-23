import {
  type HbarPoolEntry,
  type PoolState,
  type PositionAmounts,
  type PositionFields,
  type PositionRange,
  formatHbar,
  formatTokenAmount,
  orderPoolTokens,
  tinybar,
} from "~~/lib/hedera";

// What the positions route turns library answers into. Nothing here reads, and nothing here decides: a position is
// shown in the units its holder thinks in, and where it stands against the live price is said in one sentence,
// because that is what decides whether the position is earning anything at all.

/** The two sides of a position, each in the unit its holder gets back. */
export type AmountPair = { readonly hbar: string; readonly token: string };

/**
 * The HBAR side is named HBAR and not WHBAR on purpose: the pool holds wrapped HBAR, and the split collect this
 * template builds unwraps it in the same transaction, so what reaches the holder is native HBAR.
 */
export function amountPair(amounts: PositionAmounts, pool: HbarPoolEntry): AmountPair {
  const { hbarIsToken0 } = orderPoolTokens(pool);
  const hbarSide = hbarIsToken0 ? amounts.amount0 : amounts.amount1;
  const tokenSide = hbarIsToken0 ? amounts.amount1 : amounts.amount0;
  return { hbar: formatHbar(tinybar(hbarSide)), token: formatTokenAmount(tokenSide, pool.token) };
}

/** A pool's fee as its holders read it: `fee` is in hundredths of a basis point, so 3000 is 0.30 %. */
export function feeTierLabel(fee: number): string {
  return `${(fee / 10_000).toFixed(2)} %`;
}

export type RangeLine = { readonly label: string; readonly sentence: string };

/**
 * Where the live price sits against the position's range, and what that makes of it. A position out of range earns
 * nothing and holds one token only, which is the state a holder has to see before deciding anything.
 */
export function rangeLine(range: PositionRange, pool: HbarPoolEntry): RangeLine {
  const { hbarIsToken0 } = orderPoolTokens(pool);
  const [lowSide, highSide] = hbarIsToken0 ? ["HBAR", pool.token.symbol] : [pool.token.symbol, "HBAR"];
  if (range === "in-range") {
    return {
      label: "In range",
      sentence: `The pool's price is inside this range: the position holds both sides and earns its share of the ${feeTierLabel(pool.fee)} fee.`,
    };
  }
  if (range === "below") {
    return {
      label: "Below the range",
      sentence: `The pool's price is under this range, so the position is ${lowSide} alone and earns nothing until the price comes back up.`,
    };
  }
  return {
    label: "Above the range",
    sentence: `The pool's price is at or above this range, so the position is ${highSide} alone and earns nothing until the price comes back down.`,
  };
}

/** The ticks a position was opened between, as the manager reports them. */
export function tickRangeLine(position: PositionFields): string {
  return `${position.tickLower} to ${position.tickUpper}`;
}

/** Where the pool is now, with the spacing every range of that pool is a multiple of. */
export function poolTickLine(pool: PoolState): string {
  return `${pool.tick} (ticks of this pool are multiples of ${pool.tickSpacing})`;
}

/** Digits a person can count: a liquidity is a bare integer of no unit, often eleven digits long. */
export function groupDigits(value: bigint): string {
  return value.toLocaleString("en-US");
}

export const EMPTY_LIST =
  "This account holds no serial of the position collection. Nothing was refused: the mirror node answered, and the " +
  "list is empty.";

export const MORE_THAN_ONE_PAGE =
  "The mirror node has more serials than one page holds, and this route reads one page. The serials above are the " +
  "oldest of them.";

/** Why a route that lists positions offers no button that changes one. */
export const READ_ONLY_NOTE =
  "This route reads. Opening a position, taking liquidity out of it, collecting what it owes and burning the serial " +
  "are four transactions, and this template keeps them out of the browser: the calls are built and checked in " +
  "packages/nextjs/lib/hedera/position.ts.";
