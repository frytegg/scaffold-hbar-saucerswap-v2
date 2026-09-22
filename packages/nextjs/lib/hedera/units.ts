import { formatUnits } from "viem";

declare const unit: unique symbol;

/** HBAR in tinybar (10^-8 HBAR): calldata amounts, `msg.value` inside a contract, and every mirror node amount. */
export type Tinybar = bigint & { readonly [unit]: "tinybar" };

/** HBAR in weibar (10^-18 HBAR): the unit of a JSON-RPC transaction `value`, and of nothing else. */
export type Weibar = bigint & { readonly [unit]: "weibar" };

export const WEIBAR_PER_TINYBAR = 10_000_000_000n;
const TINYBAR_PER_HBAR = 100_000_000n;
const TINYBAR_DECIMALS = 8;
const WEIBAR_DECIMALS = 18;
const HBAR_AMOUNT = /^(\d+)(?:\.(\d+))?$/;

export type UnitErrorCode =
  | "negative-amount"
  | "not-an-hbar-amount"
  | "too-many-decimals"
  | "value-below-one-tinybar"
  | "value-not-whole-tinybar"
  | "value-does-not-cover-amount-in";

export class UnitError extends Error {
  readonly code: UnitErrorCode;

  constructor(code: UnitErrorCode, message: string) {
    super(message);
    this.name = "UnitError";
    this.code = code;
  }
}

export function tinybar(amount: bigint): Tinybar {
  if (amount < 0n) throw new UnitError("negative-amount", `${amount} tinybar is negative.`);
  return amount as Tinybar;
}

/** Parses an amount typed in HBAR, such as "1" or "0.25", without going through floating point. */
export function hbarToTinybar(hbar: string): Tinybar {
  const match = HBAR_AMOUNT.exec(hbar.trim());
  if (!match) throw new UnitError("not-an-hbar-amount", `"${hbar}" is not an HBAR amount such as 1 or 0.25.`);
  const [, whole, fraction = ""] = match;
  if (fraction.length > TINYBAR_DECIMALS) {
    throw new UnitError(
      "too-many-decimals",
      `"${hbar}" HBAR has more than ${TINYBAR_DECIMALS} decimals: the smallest amount is 1 tinybar (0.00000001 HBAR).`,
    );
  }
  return tinybar(BigInt(whole) * TINYBAR_PER_HBAR + BigInt(fraction.padEnd(TINYBAR_DECIMALS, "0")));
}

export function toWeibar(amount: Tinybar): Weibar {
  return (amount * WEIBAR_PER_TINYBAR) as Weibar;
}

/**
 * Refuses a JSON-RPC value the network cannot carry: the relay rejects a non-zero value below 1 tinybar, and the
 * network silently drops any remainder below 1 tinybar while the relay keeps echoing the signed value.
 */
export function assertJsonRpcValue(value: bigint): Weibar {
  if (value < 0n) throw new UnitError("negative-amount", `A transaction value of ${value} weibar is negative.`);
  if (value > 0n && value < WEIBAR_PER_TINYBAR) {
    throw new UnitError(
      "value-below-one-tinybar",
      `A transaction value of ${value} weibar is below 1 tinybar (10^10 weibar), and the JSON-RPC relay refuses it. ` +
        "Transaction values are weibar: multiply the tinybar amount by 10^10.",
    );
  }
  const remainder = value % WEIBAR_PER_TINYBAR;
  if (remainder !== 0n) {
    throw new UnitError(
      "value-not-whole-tinybar",
      `A transaction value of ${value} weibar is not a whole number of tinybar: the network would move ` +
        `${value / WEIBAR_PER_TINYBAR} tinybar and drop the other ${remainder} weibar without an error.`,
    );
  }
  return value as Weibar;
}

/** Converts a value read over JSON-RPC (a balance, a transaction value) to tinybar, refusing a sub-tinybar remainder. */
export function toTinybar(value: bigint): Tinybar {
  return tinybar(assertJsonRpcValue(value) / WEIBAR_PER_TINYBAR);
}

/**
 * The error for an HBAR-input payment whose value is below the amount the call spends, or null when it covers it.
 * With too little value the SaucerSwap router tries to pull WHBAR tokens from the sender instead, and the simulation
 * answers INSUFFICIENT_TOKEN_BALANCE.
 */
export function valueShortfall(value: Weibar, amountIn: Tinybar): UnitError | null {
  if (value >= toWeibar(amountIn)) return null;
  return new UnitError(
    "value-does-not-cover-amount-in",
    `The transaction value, ${formatWeibar(value)} (${formatUnits(value, WEIBAR_DECIMALS)} HBAR), does not cover ` +
      `amountIn, ${formatTinybar(amountIn)} (${formatHbar(amountIn)}). Transaction values are weibar: pass ` +
      "amountIn × 10^10.",
  );
}

export function assertValueCoversAmountIn(value: Weibar, amountIn: Tinybar): void {
  const shortfall = valueShortfall(value, amountIn);
  if (shortfall !== null) throw shortfall;
}

/**
 * The one way to give a transaction its HBAR value outside this library (the lint guard refuses `value:` elsewhere).
 * With `amountIn`, the value must cover what the call spends.
 */
export function payable(amount: Tinybar, amountIn?: Tinybar): { value: Weibar } {
  const value = assertJsonRpcValue(toWeibar(amount));
  if (amountIn !== undefined) assertValueCoversAmountIn(value, amountIn);
  return { value };
}

export function formatHbar(amount: Tinybar): string {
  return `${formatUnits(amount, TINYBAR_DECIMALS)} HBAR`;
}

export function formatTinybar(amount: Tinybar): string {
  return `${amount} tinybar`;
}

export function formatWeibar(value: Weibar): string {
  return `${value} weibar`;
}

export function formatTokenAmount(
  amount: bigint,
  token: { readonly decimals: number; readonly symbol: string },
): string {
  return `${formatUnits(amount, token.decimals)} ${token.symbol}`;
}
