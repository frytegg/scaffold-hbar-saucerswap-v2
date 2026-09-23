import type { HbarPoolEntry } from "../addresses";
import { type PositionAmounts, amountsForLiquidity, liquidityForAmounts } from "../liquidityMath";
import { type Minimums, orderPoolTokens } from "../position";
import type { PositionFields } from "../positionReads";
import type { PreflightVerdict } from "../preflight";
import type { TickRange } from "../tickMath";
import { type Tinybar, formatHbar, formatTokenAmount, tinybar } from "../units";
import { EvidenceRunRefusal } from "./runGuards";

// What the signed position cycle (positions.signed.ts) decides before it signs anything: how much the range needs,
// what it is willing to deposit, and the refusals that stop the run rather than send a transaction that would open
// a position nobody planned. Kept pure so that the offline tier fails each one and checks its message.

const BASIS_POINTS = 10_000n;

/** The two amounts of a position, said in the terms a caller thinks in rather than in the pool's token order. */
export type PoolAmounts = { readonly hbar: bigint; readonly token: bigint };

/**
 * The pool holds its two tokens in the order of their addresses, which decides whether HBAR is `amount0` or
 * `amount1`. Everything else in the run works in HBAR and token terms and crosses that seam here.
 */
export function poolSides(pool: HbarPoolEntry): {
  readonly toPair: (amounts: PoolAmounts) => PositionAmounts;
  readonly fromPair: (amounts: PositionAmounts) => PoolAmounts;
} {
  const { hbarIsToken0 } = orderPoolTokens(pool);
  return {
    toPair: ({ hbar, token }) => (hbarIsToken0 ? { amount0: hbar, amount1: token } : { amount0: token, amount1: hbar }),
    fromPair: ({ amount0, amount1 }) =>
      hbarIsToken0 ? { hbar: amount0, token: amount1 } : { hbar: amount1, token: amount0 },
  };
}

export type DepositPlan = {
  /** The liquidity those amounts buy at the price that was read. */
  readonly liquidity: bigint;
  /** What the range needs at that price, rounded up as a deposit is charged. */
  readonly needed: PoolAmounts;
};

/**
 * What one HBAR target buys over a range, and what the other side of it costs. The token side is a budget and not a
 * target: near the top of a range the price wants almost no HBAR, so the HBAR target alone would buy a position as
 * large as the token balance allows, and the refusal below is what stops a run from depositing more than it planned.
 */
export function planDeposit(request: {
  readonly pool: HbarPoolEntry;
  readonly sqrtPriceX96: bigint;
  readonly range: TickRange;
  readonly hbarTarget: Tinybar;
  readonly hbarBudget: Tinybar;
  readonly tokenBudget: bigint;
}): DepositPlan {
  const { pool, sqrtPriceX96, range, hbarTarget, hbarBudget, tokenBudget } = request;
  const { toPair, fromPair } = poolSides(pool);
  const at = { ...range, sqrtPriceX96 };
  const liquidity = liquidityForAmounts({ ...at, ...toPair({ hbar: hbarTarget, token: tokenBudget }) });
  const needed = fromPair(amountsForLiquidity({ ...at, liquidity }, "deposit"));
  if (needed.hbar > hbarBudget || needed.token > tokenBudget) {
    throw new EvidenceRunRefusal(
      `A position over [${range.tickLower}, ${range.tickUpper}] at this price would deposit ` +
        `${formatHbar(tinybar(needed.hbar))} and ${formatTokenAmount(needed.token, pool.token)}, over the ` +
        `${formatHbar(hbarBudget)} and ${formatTokenAmount(tokenBudget, pool.token)} this run is allowed to put ` +
        "in. Nothing was sent.",
    );
  }
  return { liquidity, needed };
}

function scaled(amounts: PoolAmounts, numerator: bigint): PoolAmounts {
  return { hbar: (amounts.hbar * numerator) / BASIS_POINTS, token: (amounts.token * numerator) / BASIS_POINTS };
}

function assertBasisPoints(bps: number, what: string): bigint {
  if (!Number.isInteger(bps) || bps <= 0 || bps >= Number(BASIS_POINTS)) {
    throw new EvidenceRunRefusal(`${what} of ${bps} basis points is not a whole number between 1 and 9999.`);
  }
  return BigInt(bps);
}

/**
 * The amounts the call offers: above what the range needs, so that a price that moves between the read and consensus
 * still finds enough of both sides. What the mint does not use of the HBAR comes back in the same transaction
 * through `refundETH`, and what it does not pull of the token stays where it is.
 */
export function offered(needed: PoolAmounts, marginBps: number): PoolAmounts {
  return scaled(needed, BASIS_POINTS + assertBasisPoints(marginBps, "A margin"));
}

/**
 * The floor the call refuses to go under, as a tolerance below what the range needs. Inside a range one spacing
 * wide, a single tick of price movement moves the share of each token by a few per cent, so this tolerance is about
 * how far the price may travel before consensus and not about a swap's price impact.
 */
export function minimumsUnder(needed: PoolAmounts, pool: HbarPoolEntry, toleranceBps: number): Minimums {
  const floor = scaled(needed, BASIS_POINTS - assertBasisPoints(toleranceBps, "A tolerance"));
  const { amount0, amount1 } = poolSides(pool).toPair(floor);
  return { amount0Min: amount0, amount1Min: amount1 };
}

/** The serial the mint created: the one the account holds now and did not hold before. */
export function newSerial(before: readonly bigint[], after: readonly bigint[]): bigint {
  const held = new Set(before.map(serial => serial.toString()));
  const opened = after.filter(serial => !held.has(serial.toString()));
  if (opened.length === 1) return opened[0];
  const listed = opened.length === 0 ? "none" : opened.join(", ");
  throw new EvidenceRunRefusal(
    `The mint should have left exactly one new position on the account, and the mirror node lists ${listed} ` +
      `(${before.length} serials before, ${after.length} after). The cycle stops rather than close a position it ` +
      "cannot name.",
  );
}

/** Every pre-flight verdict, and the refusal a failing one raises before the wallet is asked for anything. */
export function assertPreflightPasses(verdicts: readonly PreflightVerdict[], what: string): void {
  const blocked = verdicts.filter(verdict => verdict.status === "fail");
  if (blocked.length === 0) return;
  throw new EvidenceRunRefusal(
    `The pre-flight blocks this ${what}: ${blocked
      .map(verdict => `${verdict.check} (${verdict.action}) — ${verdict.message}`)
      .join(" ")} Nothing was sent.`,
  );
}

/** The position the mint created, as the manager answers for it: a serial it does not know is not a position. */
export function openedPosition(position: PositionFields | null, tokenId: bigint): PositionFields {
  if (position === null) {
    throw new EvidenceRunRefusal(
      `The mirror node lists position ${tokenId} on the account, and the position manager does not know that ` +
        "serial. Nothing more was sent.",
    );
  }
  if (position.liquidity === 0n) {
    throw new EvidenceRunRefusal(`Position ${tokenId} was created with no liquidity: the mint deposited nothing.`);
  }
  return position;
}

/**
 * The position after the decrease: the manager owes it the whole principal and holds none of its liquidity. A
 * decrease that left liquidity behind would make the collect pay out less than the cycle claims.
 */
export function assertEmptied(position: PositionFields | null, tokenId: bigint): PositionFields {
  if (position === null) {
    throw new EvidenceRunRefusal(
      `The position manager no longer knows position ${tokenId}, which the cycle just decreased.`,
    );
  }
  if (position.liquidity !== 0n) {
    throw new EvidenceRunRefusal(
      `Position ${tokenId} still holds ${position.liquidity} of liquidity after the decrease, so the collect would ` +
        "leave part of it in the pool. Nothing more was sent.",
    );
  }
  if (position.tokensOwed0 === 0n && position.tokensOwed1 === 0n) {
    throw new EvidenceRunRefusal(
      `Position ${tokenId} is owed nothing after the decrease: there would be nothing for the collect to pay out.`,
    );
  }
  return position;
}

/**
 * The HBAR the collect paid, from the account's own line in the transaction record. It is the proof the split
 * collect delivers HBAR and not the wrapped token: a collect that paid WHBAR moves no HBAR into the account, so
 * the account's net movement is the fee alone and this refuses.
 */
export function hbarPaidByCollect({
  senderNetTinybar,
  feeTinybar,
  owed,
}: {
  senderNetTinybar: bigint;
  feeTinybar: bigint;
  owed: bigint;
}): Tinybar {
  const paid = senderNetTinybar + feeTinybar;
  if (paid !== owed) {
    throw new EvidenceRunRefusal(
      `The collect moved ${paid} tinybar into the account while the position was owed ${owed}: the HBAR side did ` +
        "not arrive as HBAR. The three calls of the split collect are what unwraps it.",
    );
  }
  return tinybar(paid);
}

/** The position after the burn: the manager must no longer know the serial, and the account must no longer hold it. */
export function assertBurnt(position: PositionFields | null, serials: readonly bigint[], tokenId: bigint): void {
  if (position !== null) {
    throw new EvidenceRunRefusal(`The position manager still answers for position ${tokenId} after the burn.`);
  }
  if (serials.some(serial => serial === tokenId)) {
    throw new EvidenceRunRefusal(`The mirror node still lists position ${tokenId} on the account after the burn.`);
  }
}
