import { createMirrorClient } from "../mirror";
import { mirrorPaths } from "../mirrorPaths";
import { facadeResultVerdict } from "../preflight";
import { swapAmountOut } from "../swap";
import { netTransfer, networkFee } from "../transfers";
import { UnitError, WEIBAR_PER_TINYBAR, toTinybar } from "../units";
import { mirrorBody, mirrorFixture, replayClient, replayMirror, rpcFixture } from "./replay";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";

/**
 * Three proof rows of docs/hedera-behaviour.md whose answers nothing else in this repository held: two from the
 * research probes of 21 September 2026 and one from the browser session of 22 September. The link check refuses a
 * hash it cannot corroborate, and these three were declared as exceptions to it until this file captured them. Each
 * test asserts what its row's outcome column claims, so a row that stops being true fails here first.
 */

/** The account every transaction of this project was signed by. */
const SENDER = "0.0.10645914";
/** The account the sub-tinybar transfer paid, by the EVM address of its own it answers to. */
const RECIPIENT = "0.0.10650085";

const HBAR_AND_HALF_A_TINYBAR = mirrorBody("result-one-hbar-and-half-a-tinybar").hash as Hex;
const ASSOCIATE_AGAIN = mirrorBody("result-contract-associate-again-194").hash as Hex;
const WALLET_SWAP = mirrorBody("result-wallet-swap-after-approval").hash as Hex;

const mirror = createMirrorClient({
  transport: replayMirror({
    [mirrorPaths.contractResult(HBAR_AND_HALF_A_TINYBAR)]: mirrorFixture("result-one-hbar-and-half-a-tinybar"),
    [mirrorPaths.transaction("1790004201.731811043")]: mirrorFixture("transaction-one-hbar-and-half-a-tinybar"),
    [mirrorPaths.contractResult(ASSOCIATE_AGAIN)]: mirrorFixture("result-contract-associate-again-194"),
    [mirrorPaths.contractResult(WALLET_SWAP)]: mirrorFixture("result-wallet-swap-after-approval"),
    [mirrorPaths.transaction("1790109976.825830514")]: mirrorFixture("transaction-wallet-swap-after-approval"),
  }),
});

describe("a transaction value that is not a whole number of tinybar", () => {
  const relay = replayClient([rpcFixture("transaction-by-hash-one-hbar-and-half-a-tinybar")]);

  it("is carried, charged and silently reduced", async () => {
    // What was signed, as the relay still echoes it: 1 HBAR and half a tinybar.
    const signed = (await relay.getTransaction({ hash: HBAR_AND_HALF_A_TINYBAR })).value;
    expect(signed).toBe(10n ** 18n + 5n * 10n ** 9n);

    const result = await mirror.getContractResult(HBAR_AND_HALF_A_TINYBAR);
    expect(result?.result).toBe("SUCCESS");
    expect(result?.errorMessage).toBeNull();
    // What the network moved: the whole tinybar of that value, and nothing of the remainder.
    expect(result?.amount).toBe(signed / WEIBAR_PER_TINYBAR);
    expect(result?.amount).toBe(100_000_000n);

    const record = await mirror.getTransaction("1790004201.731811043");
    const transfers = record?.transfers ?? [];
    expect(netTransfer(transfers, RECIPIENT)).toBe(100_000_000n);
    expect(networkFee(transfers)).toBe(2_289_000n);
    // The sender paid what the recipient received and the fee: the half tinybar is in no line of the record.
    expect(netTransfer(transfers, SENDER)).toBe(-(100_000_000n + 2_289_000n));
  });

  it("is refused by toTinybar, which says what the network would do with it instead", () => {
    let thrown: unknown;
    try {
      toTinybar(10n ** 18n + 5n * 10n ** 9n);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnitError);
    expect((thrown as UnitError).code).toBe("value-not-whole-tinybar");
    expect((thrown as UnitError).message).toContain("move 100000000 tinybar and drop the other 5000000000 weibar");
  });
});

describe("a redundant association", () => {
  it("is a successful transaction with a failure inside it", async () => {
    const result = await mirror.getContractResult(ASSOCIATE_AGAIN);
    expect(result?.result).toBe("SUCCESS");
    expect(result?.errorMessage).toBeNull();
    // The row's figure: a call that bought nothing, charged for 731,858 gas.
    expect(result?.gasUsed).toBe(731_858n);

    // The token service's answer is the whole call result, one 32-byte word, and the transaction still succeeded.
    const responseCode = BigInt(result?.callResult ?? "0x");
    expect(responseCode).toBe(194n);

    const verdict = facadeResultVerdict(responseCode);
    expect(verdict.status).toBe("fail");
    expect(verdict.message).toContain("194 (TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT)");
  });
});

describe("the swap the browser wallet sent once the router had its allowance", () => {
  it("paid native HBAR, in the amount the router itself returned", async () => {
    const result = await mirror.getContractResult(WALLET_SWAP);
    expect(result?.result).toBe("SUCCESS");

    const amountOut = swapAmountOut(result?.callResult ?? "0x");
    expect(amountOut).toBe(2_140_819n);

    const record = await mirror.getTransaction("1790109976.825830514");
    const transfers = record?.transfers ?? [];
    // The row's cost: 0.98327156 HBAR of fee.
    expect(networkFee(transfers)).toBe(98_327_156n);
    // And the sender's whole movement is that fee against the router's amountOut, credited in HBAR itself: had the
    // output arrived as WHBAR, the HBAR line would be the fee alone and the token would be in a transfer list.
    expect(netTransfer(transfers, SENDER)).toBe(amountOut - networkFee(transfers));
  });
});
