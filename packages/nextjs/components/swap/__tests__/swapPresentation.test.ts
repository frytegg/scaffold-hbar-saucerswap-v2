import {
  HBAR_UNIT,
  QUOTE_TTL_MS,
  SAUCERSWAP_UNAVAILABLE,
  SwapFormError,
  actionLabelFor,
  blocks,
  checkOf,
  checkOfRefusal,
  directionLabel,
  facadeReturnVerdict,
  hashscanTransactionUrl,
  headlineFor,
  mirrorResultUrl,
  parseAmountInput,
  parseSlippagePercent,
  quoteFreshness,
  unitsOf,
} from "../swapPresentation";
import { describe, expect, it } from "vitest";
import { type HederaFailure, allowanceVerdict, formatTokenAmount, testnet } from "~~/lib/hedera";

const SAUCE = testnet.sauce;
const HASH = "0x756bfe6431ace6935b49bd415b53a2e29cee7b8df1f863adafe42b101e88dabc" as const;

function failure(patch: Partial<HederaFailure>): HederaFailure {
  return { kind: "unknown", code: null, statusName: null, message: "something", action: "none", via: "test", ...patch };
}

describe("the amount a person types", () => {
  it("becomes the token's smallest unit without going through floating point", () => {
    expect(parseAmountInput("0.1", HBAR_UNIT)).toBe(10_000_000n);
    expect(parseAmountInput("1.234567", SAUCE)).toBe(1_234_567n);
    expect(parseAmountInput(" 12 ", SAUCE)).toBe(12_000_000n);
  });

  it("is refused when it has more decimals than the unit, naming both counts", () => {
    expect(() => parseAmountInput("0.1234567", SAUCE)).toThrowError('SAUCE has 6 decimals: "0.1234567" has 7.');
    expect(() => parseAmountInput("0.123456789", HBAR_UNIT)).toThrowError('HBAR has 8 decimals: "0.123456789" has 9.');
  });

  it("is refused when it is not a number at all", () => {
    expect(() => parseAmountInput("all of it", HBAR_UNIT)).toThrowError(
      '"all of it" is not an amount of HBAR, such as 1 or 0.25.',
    );
    expect(() => parseAmountInput("-1", HBAR_UNIT)).toThrowError(SwapFormError);
  });

  it("is refused when it is zero: there is nothing to quote", () => {
    expect(() => parseAmountInput("0.00", SAUCE)).toThrowError(
      "Enter an amount of SAUCE above 0: there is nothing to quote.",
    );
  });
});

describe("the slippage a person types", () => {
  it("becomes the basis points the router's minimum output is computed in", () => {
    expect(parseSlippagePercent("0.5")).toBe(50);
    expect(parseSlippagePercent("5")).toBe(500);
    expect(parseSlippagePercent("0")).toBe(0);
  });

  it("is refused past a hundredth of a percent, which the basis points cannot carry", () => {
    expect(() => parseSlippagePercent("0.005")).toThrowError(
      'A slippage is set in hundredths of a percent at most: "0.005" is finer than that.',
    );
  });

  it("is refused at 100 %, which accepts any price the swap is given", () => {
    expect(() => parseSlippagePercent("100")).toThrowError(
      "A slippage of 100 % leaves no minimum output, so the swap would accept any price it is given.",
    );
  });

  it("is refused when it is not a percentage", () => {
    expect(() => parseSlippagePercent("half")).toThrowError('"half" is not a percentage, such as 0.5.');
  });
});

describe("a verdict becomes a line of the panel", () => {
  it("carries the one thing to do when it blocks, and nothing when it passes", () => {
    const amount = formatTokenAmount(1_000_000n, SAUCE);
    const missing = checkOf("preflight", "Allowance", allowanceVerdict(0n, 1_000_000n, SAUCE), amount);
    expect(missing.status).toBe("fail");
    expect(missing.message).toContain("The SaucerSwap router has no allowance to spend your SAUCE.");
    expect(missing.actionLabel).toBe("Approve 1 SAUCE for the router");

    const granted = checkOf("preflight", "Allowance", allowanceVerdict(1_000_000n, 1_000_000n, SAUCE));
    expect(granted.status).toBe("pass");
    expect(granted.actionLabel).toBeNull();
  });

  it("blocks the panel as soon as one line blocks", () => {
    const pass = checkOf("cost", "Network fee", allowanceVerdict(5n, 5n, SAUCE));
    const fail = checkOfRefusal("build", "Build", { message: "no", action: "none" });
    expect(blocks([pass])).toBe(false);
    expect(blocks([pass, fail])).toBe(true);
  });

  it("names the step the page cannot take itself", () => {
    expect(actionLabelFor("associate")).toBe("Associate the token from that account first");
    expect(actionLabelFor("fund")).toBe("Send HBAR to that address first");
    expect(actionLabelFor("supply-gas")).toContain("lib/hedera/gasRules.ts");
    expect(actionLabelFor("none")).toBeNull();
    expect(actionLabelFor("approve")).toBe("Approve the router");
  });
});

describe("a failure gets the right heading", () => {
  it("is headed as unavailable when nothing answered, because the swap itself may be sound", () => {
    const headlines = { refused: "Quote", unavailable: SAUCERSWAP_UNAVAILABLE };
    expect(headlineFor(failure({ kind: "unavailable" }), headlines)).toBe(SAUCERSWAP_UNAVAILABLE);
    expect(headlineFor(failure({ kind: "rate-limited" }), headlines)).toBe(SAUCERSWAP_UNAVAILABLE);
  });

  it("keeps the refusal's own heading when the network answered", () => {
    const headlines = { refused: "Quote", unavailable: SAUCERSWAP_UNAVAILABLE };
    expect(headlineFor(failure({ kind: "hts-response-code" }), headlines)).toBe("Quote");
  });
});

describe("what the token facade returned after an approval", () => {
  it("passes on the ERC-20 true", () => {
    const verdict = facadeReturnVerdict(`0x${"0".repeat(63)}1`);
    expect(verdict.status).toBe("pass");
    expect(verdict.message).toBe("The token facade returned true: the approval went through.");
  });

  it("blocks on false, and says the transaction was charged all the same", () => {
    const verdict = facadeReturnVerdict(`0x${"0".repeat(64)}`);
    expect(verdict.status).toBe("fail");
    expect(verdict.message).toContain("the transaction succeeded and was charged");
  });

  it("blocks on a Hedera response code other than 22, naming the status", () => {
    const verdict = facadeReturnVerdict(`0x${(194).toString(16).padStart(64, "0")}`);
    expect(verdict.status).toBe("fail");
    expect(verdict.message).toContain("194");
    expect(verdict.message).toContain("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT");
  });

  it("blocks when the transaction returned no value at all", () => {
    expect(facadeReturnVerdict(null).status).toBe("fail");
    expect(facadeReturnVerdict("0x").message).toContain("whether the HTS operation happened is unknown");
  });
});

describe("how old a quote is", () => {
  it("says nothing while it is fresh", () => {
    expect(quoteFreshness(1_000, 1_000 + QUOTE_TTL_MS - 1)).toEqual({ secondsOld: 59, stale: false, message: null });
  });

  it("blocks the send once it is past its time to live, and says how old it is", () => {
    const freshness = quoteFreshness(1_000, 1_000 + QUOTE_TTL_MS + 5_000);
    expect(freshness.stale).toBe(true);
    expect(freshness.message).toContain("65 seconds old");
    expect(freshness.message).toContain("Get a new quote.");
  });
});

describe("the route's own vocabulary", () => {
  it("names each direction by the units a person types and receives", () => {
    expect(directionLabel("hbar-to-token", SAUCE)).toBe("HBAR to SAUCE");
    expect(directionLabel("token-to-hbar", SAUCE)).toBe("SAUCE to HBAR");
    expect(unitsOf("token-to-hbar", SAUCE).output).toBe(HBAR_UNIT);
  });

  it("links a transaction to the mirror node's DETAIL view and to Hashscan", () => {
    expect(mirrorResultUrl(HASH)).toBe(`https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${HASH}`);
    expect(hashscanTransactionUrl(HASH)).toBe(`https://hashscan.io/testnet/tx/${HASH}`);
  });
});
