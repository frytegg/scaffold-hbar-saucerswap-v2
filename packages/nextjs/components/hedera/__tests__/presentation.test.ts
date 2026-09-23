import {
  MIRROR_UNAVAILABLE,
  SAUCERSWAP_UNAVAILABLE,
  actionLabelFor,
  headlineFor,
  isInPageAction,
} from "../failureText";
import { hashscanContractUrl, hashscanNftUrl, hashscanTransactionUrl, mirrorNftUrl, mirrorResultUrl } from "../links";
import { describe, expect, it } from "vitest";
import type { HederaFailure } from "~~/lib/hedera";

const HASH = "0x756bfe6431ace6935b49bd415b53a2e29cee7b8df1f863adafe42b101e88dabc" as const;
const LP_NFT = "0.0.1310436" as const;

function failure(patch: Partial<HederaFailure>): HederaFailure {
  return { kind: "unknown", code: null, statusName: null, message: "something", action: "none", via: "test", ...patch };
}

describe("the one thing to do about a failure", () => {
  it("names the step no page can take for the person", () => {
    expect(actionLabelFor("associate")).toBe("Associate the token from that account first");
    expect(actionLabelFor("fund")).toBe("Send HBAR to that address first");
    expect(actionLabelFor("supply-gas")).toContain("lib/hedera/gasRules.ts");
    expect(actionLabelFor("none")).toBeNull();
    expect(actionLabelFor("approve")).toBe("Approve the router");
  });

  it("names the amount when the page offers the approval itself", () => {
    expect(actionLabelFor("approve", "1.0 SAUCE")).toBe("Approve 1.0 SAUCE for the router");
  });

  it("offers a button only for the actions a page carries out", () => {
    expect(isInPageAction("approve")).toBe(true);
    expect(isInPageAction("requote")).toBe(true);
    expect(isInPageAction("retry")).toBe(true);
    expect(isInPageAction("associate")).toBe(false);
    expect(isInPageAction("supply-gas")).toBe(false);
  });
});

describe("a failure gets the right heading", () => {
  it("is headed as unavailable when nothing answered, because what was asked for may be sound", () => {
    const headlines = { refused: "Quote", unavailable: SAUCERSWAP_UNAVAILABLE };
    expect(headlineFor(failure({ kind: "unavailable" }), headlines)).toBe(SAUCERSWAP_UNAVAILABLE);
    expect(headlineFor(failure({ kind: "rate-limited" }), headlines)).toBe(SAUCERSWAP_UNAVAILABLE);
  });

  it("keeps the refusal's own heading when the network answered", () => {
    const headlines = { refused: "Your positions could not be listed", unavailable: MIRROR_UNAVAILABLE };
    expect(headlineFor(failure({ kind: "hts-response-code" }), headlines)).toBe("Your positions could not be listed");
  });
});

describe("where a reader checks what a page says", () => {
  it("links a transaction to the mirror node's DETAIL view and to Hashscan", () => {
    expect(mirrorResultUrl(HASH)).toBe(`https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${HASH}`);
    expect(hashscanTransactionUrl(HASH)).toBe(`https://hashscan.io/testnet/tx/${HASH}`);
  });

  it("links one serial of a collection, which is where a burnt position says so", () => {
    expect(mirrorNftUrl(LP_NFT, 360n)).toBe("https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.1310436/nfts/360");
    expect(hashscanNftUrl(LP_NFT, 360n)).toBe("https://hashscan.io/testnet/token/0.0.1310436/360");
  });

  it("links a contract by its entity id, the form Hashscan and the mirror node agree on", () => {
    expect(hashscanContractUrl("0.0.1308184")).toBe("https://hashscan.io/testnet/contract/0.0.1308184");
  });
});
