import { WALLET_FEE_NOTE, feeForGas } from "../cost";
import type { Tinybar } from "../units";
import { walletFeeDisplay } from "./replay";
import { describe, expect, it } from "vitest";

// The wallet priced the gas LIMIT, the network charged the gas USED. Both halves of each pair are checked against
// the same figures: the limits, the gas used and the fees come from the mirror node, the displayed figure from the
// screenshots of the session.
const display = walletFeeDisplay();
const WALLET_GAS_PRICE = BigInt(display.gasPriceTinybarPerGas) * 10_000_000_000n;
const EFFECTIVE_GAS_PRICE = BigInt(display.effectiveGasPriceTinybarPerGas) * 10_000_000_000n;

/** The same amount as a wallet writes it: four decimals, rounded half up. */
function asTheWalletShowsIt(fee: Tinybar): string {
  const tenThousandths = (fee + 5_000n) / 10_000n;
  const fraction = `${tenThousandths % 10_000n}`.padStart(4, "0").replace(/0+$/, "");
  return `${tenThousandths / 10_000n}${fraction === "" ? "" : `.${fraction}`}`;
}

describe("the fee a wallet displays against the fee the network charges", () => {
  it.each(display.rows.map(row => [row.label, row] as const))("%s", (_label, row) => {
    expect(asTheWalletShowsIt(feeForGas(BigInt(row.gasLimit), WALLET_GAS_PRICE))).toBe(row.walletShownHbar);
    expect(feeForGas(BigInt(row.gasUsed), EFFECTIVE_GAS_PRICE)).toBe(BigInt(row.feeTinybar));
  });

  it("the wallet announced more than the network took, on every measured transaction", () => {
    for (const row of display.rows) {
      expect(feeForGas(BigInt(row.gasLimit), WALLET_GAS_PRICE)).toBeGreaterThan(BigInt(row.feeTinybar));
    }
    expect(display.rows).toHaveLength(7);
  });

  it("says why, in one sentence a page can show next to the preview", () => {
    expect(WALLET_FEE_NOTE).toContain("prices the gas limit");
    expect(WALLET_FEE_NOTE).toContain("only the gas the call uses");
  });
});

describe("feeForGas is an upper bound", () => {
  it("rounds a fraction of a tinybar up, never down", () => {
    expect(feeForGas(1n, 1n)).toBe(1n);
    expect(feeForGas(1n, 10_000_000_001n)).toBe(2n);
  });

  it("is exact when the price is a whole number of tinybar", () => {
    expect(feeForGas(759_459n, EFFECTIVE_GAS_PRICE)).toBe(82_781_031n);
  });
});
