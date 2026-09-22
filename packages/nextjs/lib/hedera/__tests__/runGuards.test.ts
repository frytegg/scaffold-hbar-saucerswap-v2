import {
  EvidenceRunRefusal,
  assertApprovalGranted,
  assertHolds,
  assertOwnedBySigner,
  assertTestnet,
  assertWithinCeiling,
  privateKeyOf,
  signingAccount,
} from "../__live__/runGuards";
import { testnet } from "../addresses";
import { type MirrorContractResult, createMirrorClient } from "../mirror";
import { mirrorPaths } from "../mirrorPaths";
import { hbarToTinybar } from "../units";
import { mirrorBody, mirrorFixture, replayMirror } from "./replay";
import { type Hex, encodeFunctionResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

// The signed evidence run refuses before each send it cannot justify. Each refusal fails here once, by its message.

const MAIN = "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01";
const APPROVE = mirrorBody("result-approve-success").hash as Hex;

function refusalOf(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof EvidenceRunRefusal) return error.message;
    throw error;
  }
  throw new Error("expected an EvidenceRunRefusal");
}

const mirror = createMirrorClient({
  transport: replayMirror({
    [mirrorPaths.contractResult(APPROVE)]: mirrorFixture("result-approve-success"),
    [mirrorPaths.account(MAIN)]: mirrorFixture("account-unlimited-slots"),
  }),
});

describe("the key", () => {
  it("takes 32 bytes of hexadecimal, with or without 0x", () => {
    expect(privateKeyOf("ab".repeat(32))).toBe(`0x${"ab".repeat(32)}`);
    expect(privateKeyOf(`0x${"AB".repeat(32)}`)).toBe(`0x${"AB".repeat(32)}`);
  });

  it.each(["", "ab".repeat(31), "zz".repeat(32), `0x${"ab".repeat(33)}`])("refuses %j and does not echo it", key => {
    expect(refusalOf(() => privateKeyOf(key))).toBe(
      "__RUNTIME_DEPLOYER_PRIVATE_KEY is not a 32-byte private key in hexadecimal.",
    );
  });
});

describe("the network and the account, before anything is signed", () => {
  it("refuses a relay that serves another chain than Hedera testnet", () => {
    expect(() => assertTestnet(296)).not.toThrow();
    expect(refusalOf(() => assertTestnet(295))).toBe(
      "The JSON-RPC relay serves chain 295, not Hedera testnet (296). Nothing was signed.",
    );
  });

  it("refuses a key whose EVM address no account carries", async () => {
    const nobody = `0x${"12".repeat(20)}` as const;
    expect(refusalOf(() => signingAccount(null, nobody))).toBe(
      `No Hedera testnet account has the EVM address ${nobody}, the one this key derives: fund that address first, ` +
        "which creates the account. Nothing was signed.",
    );
    const found = await mirror.getAccount(MAIN);
    expect(signingAccount(found, MAIN).accountId).toBe("0.0.10645914");
  });
});

describe("the run's spending ceiling", () => {
  const ceiling = hbarToTinybar("5");

  it("lets a send through that reaches the ceiling exactly", () => {
    expect(() =>
      assertWithinCeiling({ spent: hbarToTinybar("4"), upTo: hbarToTinybar("1"), ceiling, what: "The swap" }),
    ).not.toThrow();
  });

  it("refuses a send that could go over it, counting what the run already spent", () => {
    expect(
      refusalOf(() =>
        assertWithinCeiling({
          spent: hbarToTinybar("4"),
          upTo: hbarToTinybar("1.00000001"),
          ceiling,
          what: "The swap",
        }),
      ),
    ).toBe(
      "The swap may cost up to 1.00000001 HBAR, and this run has already spent 400000000 tinybar: that could go over " +
        "the run's ceiling of 5 HBAR. Nothing was sent.",
    );
  });
});

describe("the token swap's inputs", () => {
  it("refuses a swap for more SAUCE than the account holds", () => {
    expect(() =>
      assertHolds({ account: "0.0.10645914", held: 1_000_000n, needed: 1_000_000n, token: testnet.sauce }),
    ).not.toThrow();
    expect(
      refusalOf(() =>
        assertHolds({ account: "0.0.10645914", held: 999_999n, needed: 1_000_000n, token: testnet.sauce }),
      ),
    ).toBe("0.0.10645914 holds 0.999999 SAUCE; this swap needs 1 SAUCE. Nothing was sent.");
  });

  it("refuses to swap through a consumer the signer does not own, whose tokens it could not take back", () => {
    const consumer = "0x7E1a4337BEBB0cC8e231c6137Da17F04C7cd3409" as const;
    const stranger = "0x82756b984e8c34C28C98A3Eb6977dF106e4B3aaC" as const;
    expect(() => assertOwnedBySigner({ contract: consumer, owner: MAIN, signer: MAIN })).not.toThrow();
    // The same address in the other case: an owner check that compared the strings as typed would pass here.
    expect(() =>
      assertOwnedBySigner({ contract: consumer, owner: MAIN.toLowerCase() as typeof MAIN, signer: MAIN }),
    ).not.toThrow();

    expect(refusalOf(() => assertOwnedBySigner({ contract: consumer, owner: stranger, signer: MAIN }))).toBe(
      `The consumer at ${consumer} belongs to ${stranger}, not to the signer ${MAIN}, and it keeps the tokens it ` +
        "buys: only its owner can withdraw them. Deploy your own with the hardhat:deploy:consumer:testnet script, " +
        "which rewrites the frontend's contract list, then run this again. Nothing was sent.",
    );
  });

  it("refuses to go on after an approve that returned false or nothing", async () => {
    const approved = (await mirror.getContractResult(APPROVE)) as MirrorContractResult;
    expect(() => assertApprovalGranted(approved)).not.toThrow();

    const abi = parseAbi(["function approve(address, uint256) returns (bool)"]);
    const returnedFalse = {
      ...approved,
      callResult: encodeFunctionResult({ abi, functionName: "approve", result: false }),
    };
    const message = `${APPROVE} succeeded but the token's approve did not return true. The swap was not sent.`;
    expect(refusalOf(() => assertApprovalGranted(returnedFalse))).toBe(message);
    expect(refusalOf(() => assertApprovalGranted({ ...approved, callResult: null }))).toBe(message);
  });
});
