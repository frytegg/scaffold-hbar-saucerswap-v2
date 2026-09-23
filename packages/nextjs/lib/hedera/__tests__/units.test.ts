import { testnet } from "../addresses";
import {
  UnitError,
  type UnitErrorCode,
  assertJsonRpcValue,
  assertValueCoversAmountIn,
  formatHbar,
  formatTinybar,
  formatTokenAmount,
  formatWeibar,
  hbarToTinybar,
  payable,
  tinybar,
  toTinybar,
  toWeibar,
} from "../units";
import { mirrorBody, replayClient, rpcFixture } from "./replay";
import { type Hex, decodeAbiParameters, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";

function unitErrorOf(run: () => unknown): { code: UnitErrorCode; message: string } {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof UnitError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a UnitError, nothing was thrown");
}

describe("hbarToTinybar parses typed HBAR amounts exactly", () => {
  it.each([
    ["1", 100_000_000n],
    ["0.5", 50_000_000n],
    ["0.00000001", 1n],
    [" 12.34 ", 1_234_000_000n],
  ])("%s HBAR is %s tinybar", (typed, expected) => {
    expect(hbarToTinybar(typed)).toBe(expected);
  });

  it("refuses a ninth decimal, which would be below 1 tinybar", () => {
    expect(unitErrorOf(() => hbarToTinybar("1.000000001")).code).toBe("too-many-decimals");
  });

  it.each(["", "-1", "1e8", "1.", "abc", "1,5"])("refuses %j", typed => {
    expect(unitErrorOf(() => hbarToTinybar(typed)).code).toBe("not-an-hbar-amount");
  });
});

describe("conversions between tinybar and weibar", () => {
  it("a transaction value is the tinybar amount times 10^10", () => {
    expect(toWeibar(tinybar(1n))).toBe(10_000_000_000n);
    expect(toWeibar(hbarToTinybar("1"))).toBe(10n ** 18n);
  });

  it("the mirror reports the value of the C04v swap in tinybar: 100000000, signed as 10^18 weibar", () => {
    const swap = mirrorBody("result-hbar-to-token-success");
    expect(swap.amount).toBe(100_000_000);
    expect(toWeibar(tinybar(BigInt(swap.amount as number)))).toBe(10n ** 18n);
  });

  it("converts a JSON-RPC value back to tinybar", () => {
    expect(toTinybar(10n ** 18n)).toBe(100_000_000n);
    expect(toTinybar(0n)).toBe(0n);
  });

  it("refuses a negative tinybar amount", () => {
    expect(unitErrorOf(() => tinybar(-1n)).code).toBe("negative-amount");
  });
});

describe("assertJsonRpcValue refuses what the relay or the network would not carry", () => {
  it("accepts 0 and whole tinybar amounts", () => {
    expect(assertJsonRpcValue(0n)).toBe(0n);
    expect(assertJsonRpcValue(10_000_000_000n)).toBe(10_000_000_000n);
  });

  it("refuses 10^8 weibar, the unscaled value of 1 HBAR, as below one tinybar", () => {
    const error = unitErrorOf(() => assertJsonRpcValue(100_000_000n));
    expect(error.code).toBe("value-below-one-tinybar");
    expect(error.message).toContain("100000000 weibar is below 1 tinybar");
  });

  it("refuses 10^10 + 1 weibar, which the network would truncate to 1 tinybar", () => {
    const error = unitErrorOf(() => toTinybar(10_000_000_001n));
    expect(error.code).toBe("value-not-whole-tinybar");
    expect(error.message).toContain("move 1 tinybar and drop the other 1 weibar");
  });

  it("refuses 10^18 + 5 x 10^9 weibar, which the network would truncate to 1 HBAR", () => {
    expect(unitErrorOf(() => assertJsonRpcValue(10n ** 18n + 5_000_000_000n)).code).toBe("value-not-whole-tinybar");
  });

  it("refuses a negative value", () => {
    expect(unitErrorOf(() => assertJsonRpcValue(-10_000_000_000n)).code).toBe("negative-amount");
  });
});

describe("the two units, on transactions Hedera testnet carried", () => {
  const consumerSwap = mirrorBody("result-consumer-swap");
  const truncated = mirrorBody("result-sub-tinybar-remainder");

  it("the consumer's swap: the relay echoes the weibar signed, the mirror records the tinybar moved", async () => {
    const client = replayClient([rpcFixture("transaction-by-hash-consumer-swap")]);
    const signed = (await client.getTransaction({ hash: consumerSwap.hash as Hex })).value;
    expect(signed).toBe(60_000_000_000_000_000n);
    expect(toTinybar(signed)).toBe(BigInt(consumerSwap.amount as number));
  });

  it("msg.value reached the contract as those 6000000 tinybar: it gave back what they exceeded amountIn by", () => {
    const parameters = `0x${(consumerSwap.function_parameters as string).slice(10)}` as Hex;
    const [amountInTinybar] = decodeAbiParameters(parseAbiParameters("uint256, uint256, uint256"), parameters);
    const returned = decodeAbiParameters(parseAbiParameters("uint256, uint256"), consumerSwap.call_result as Hex);
    // refundedTinybar is address(this).balance - (balance at entry - msg.value), so it is msg.value - amountIn.
    // Had msg.value been the weibar figure, that subtraction would have underflowed and the call would have reverted.
    expect(returned[1]).toBe(BigInt(consumerSwap.amount as number) - amountInTinybar);
    expect(returned[1]).toBe(1_000_000n);
  });

  it("a value that is not a whole tinybar succeeds and loses the remainder, so the guard refuses it first", async () => {
    const client = replayClient([rpcFixture("transaction-by-hash-sub-tinybar-remainder")]);
    const signed = (await client.getTransaction({ hash: truncated.hash as Hex })).value;
    expect(signed).toBe(10_000_000_001n);
    expect(truncated.result).toBe("SUCCESS");
    expect(truncated.amount).toBe(1);
    expect(unitErrorOf(() => assertJsonRpcValue(signed)).code).toBe("value-not-whole-tinybar");
  });
});

describe("an HBAR-input value must cover amountIn", () => {
  const oneHbar = hbarToTinybar("1");

  it("refuses a value in tinybar where weibar is due", () => {
    const error = unitErrorOf(() => assertValueCoversAmountIn(assertJsonRpcValue(0n), oneHbar));
    expect(error.code).toBe("value-does-not-cover-amount-in");
    expect(error.message).toContain("amountIn, 100000000 tinybar (1 HBAR)");
  });

  it("accepts a value equal to amountIn x 10^10", () => {
    expect(() => assertValueCoversAmountIn(toWeibar(oneHbar), oneHbar)).not.toThrow();
  });
});

describe("payable is the one way to set a value outside the library", () => {
  it("scales tinybar to weibar", () => {
    expect(payable(hbarToTinybar("2"))).toEqual({ value: 2n * 10n ** 18n });
  });

  it("refuses a value below the amountIn it pays for", () => {
    expect(unitErrorOf(() => payable(hbarToTinybar("1"), hbarToTinybar("1.5"))).code).toBe(
      "value-does-not-cover-amount-in",
    );
  });
});

describe("formatting always names the unit", () => {
  it.each([
    [formatHbar(hbarToTinybar("1.5")), "1.5 HBAR"],
    [formatTinybar(tinybar(150_000_000n)), "150000000 tinybar"],
    [formatWeibar(toWeibar(tinybar(1n))), "10000000000 weibar"],
    [formatTokenAmount(10_000_000n, testnet.sauce), "10 SAUCE"],
  ])("%s", (formatted, expected) => {
    expect(formatted).toBe(expected);
  });
});
