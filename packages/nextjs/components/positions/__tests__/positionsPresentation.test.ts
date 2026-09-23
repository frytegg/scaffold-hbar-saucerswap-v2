import {
  amountPair,
  feeTierLabel,
  groupDigits,
  poolTickLine,
  rangeLine,
  tickRangeLine,
} from "../positionsPresentation";
import { describe, expect, it } from "vitest";
import { type PositionFields, testnet } from "~~/lib/hedera";

// The figures below are serial 360's, the position this project opened and closed from a browser wallet on
// 22 September 2026: range [-7680, -7620], liquidity 15,562,884,336, and the two amounts the pool itself reported.

const POOL = testnet.hbarSaucePool;

const SERIAL_360: PositionFields = {
  tokenId: 360n,
  token0: testnet.whbar.evmAddress,
  token1: testnet.sauce.evmAddress,
  fee: 3_000,
  tickLower: -7_680,
  tickUpper: -7_620,
  liquidity: 15_562_884_336n,
  tokensOwed0: 0n,
  tokensOwed1: 0n,
};

describe("the two sides of a position, in the units its holder gets back", () => {
  it("names the HBAR side HBAR, because the collect this template builds unwraps it in the same transaction", () => {
    const pair = amountPair({ amount0: 25_412_099n, amount1: 20_000_000n }, POOL);
    expect(pair.hbar).toBe("0.25412099 HBAR");
    expect(pair.token).toBe("20 SAUCE");
  });

  it("puts each side on the token the pool ordered it under, not on the one that was typed first", () => {
    const pair = amountPair({ amount0: 0n, amount1: 60_000_000n }, POOL);
    expect(pair.hbar).toBe("0 HBAR");
    expect(pair.token).toBe("60 SAUCE");
  });
});

describe("a pool's fee, as its holders read it", () => {
  it("turns hundredths of a basis point into a percentage", () => {
    expect(feeTierLabel(3_000)).toBe("0.30 %");
    expect(feeTierLabel(500)).toBe("0.05 %");
    expect(feeTierLabel(10_000)).toBe("1.00 %");
  });
});

describe("where the live price sits against a range", () => {
  it("says the position earns its share of the fee while the price is inside it", () => {
    const line = rangeLine("in-range", POOL);
    expect(line.label).toBe("In range");
    expect(line.sentence).toContain("earns its share of the 0.30 % fee");
  });

  it("names the one token that is left when the price fell under the range", () => {
    const line = rangeLine("below", POOL);
    expect(line.label).toBe("Below the range");
    expect(line.sentence).toContain("the position is HBAR alone and earns nothing");
  });

  it("names the other token when the price rose to or above the range", () => {
    const line = rangeLine("above", POOL);
    expect(line.label).toBe("Above the range");
    expect(line.sentence).toContain("the position is SAUCE alone and earns nothing");
  });
});

describe("the numbers a reader has to be able to count", () => {
  it("shows a range as the two ticks the manager reports", () => {
    expect(tickRangeLine(SERIAL_360)).toBe("-7680 to -7620");
  });

  it("shows the pool's tick with the spacing every range of that pool is a multiple of", () => {
    expect(poolTickLine({ sqrtPriceX96: 1n, tick: -7_643, tickSpacing: 60, liquidity: 1n })).toBe(
      "-7643 (ticks of this pool are multiples of 60)",
    );
  });

  it("groups the digits of a liquidity, which carries no unit and no decimal point", () => {
    expect(groupDigits(SERIAL_360.liquidity)).toBe("15,562,884,336");
  });
});
