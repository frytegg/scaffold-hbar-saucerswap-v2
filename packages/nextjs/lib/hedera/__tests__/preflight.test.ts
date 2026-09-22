import { testnet } from "../addresses";
import { type MirrorAccount, createMirrorClient } from "../mirror";
import { mirrorPaths } from "../mirrorPaths";
import {
  allowanceVerdict,
  checkAllowance,
  checkCost,
  checkRecipient,
  costVerdict,
  facadeResultVerdict,
  recipientVerdict,
} from "../preflight";
import { buildHbarToTokenSwap, buildTokenToHbarSwap, quoteExactInput, swapPath } from "../swap";
import { hbarToTinybar, tinybar } from "../units";
import { mirrorFixture, replayClient, replayMirror, rpcFixture } from "./replay";
import { decodeFunctionResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

const MAIN = "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01";
const TEN_SAUCE = 10_000_000n;

describe("allowance: the check simulation does not make", () => {
  it("the captured eth_call accepts a token -> HBAR swap with allowance 0, and the preflight refuses it", async () => {
    const swap = buildTokenToHbarSwap({
      pool: testnet.hbarSaucePool,
      recipient: MAIN,
      slippageBps: 500,
      deadline: 1_790_024_437n,
      amountIn: TEN_SAUCE,
      quotedAmountOut: tinybar(21_407_548n),
    });
    const simulator = replayClient([rpcFixture("call-token-to-hbar-allowance-zero")]);
    const { result } = await simulator.simulateContract({ ...swap, account: MAIN });
    expect(result).toHaveLength(2);

    const verdict = await checkAllowance(replayClient([rpcFixture("call-allowance-router-zero")]), {
      token: testnet.sauce,
      owner: MAIN,
      amountIn: TEN_SAUCE,
    });
    expect(verdict).toEqual({
      check: "allowance",
      status: "fail",
      action: "approve",
      message:
        "The SaucerSwap router has no allowance to spend your SAUCE. Approve 10 SAUCE first: without it the network " +
        "rejects the swap and still charges the gas.",
    });
  });

  it("an allowance below the amount fails too (the network answers 293)", () => {
    const verdict = allowanceVerdict(TEN_SAUCE, 20_000_000n, testnet.sauce);
    expect(verdict.status).toBe("fail");
    expect(verdict.action).toBe("approve");
    expect(verdict.message).toContain("may spend only 10 SAUCE, less than the 20 SAUCE of this swap");
  });

  it("an allowance equal to the amount passes", async () => {
    const verdict = allowanceVerdict(TEN_SAUCE, TEN_SAUCE, testnet.sauce);
    expect(verdict).toMatchObject({ status: "pass", action: "none" });
  });

  it("reads a real allowance through the token's ERC-20 face: 40 SAUCE left to another spender", async () => {
    const verdict = await checkAllowance(replayClient([rpcFixture("call-allowance-position-manager")]), {
      token: testnet.sauce,
      owner: MAIN,
      amountIn: 40_000_000n,
    });
    expect(verdict.status).toBe("pass");
  });
});

describe("recipient: exists, right address form, associated or able to be", () => {
  const account = (fixture: string) => {
    const body = mirrorFixture(fixture).body as Record<string, unknown>;
    return {
      accountId: body.account,
      evmAddress: body.evm_address,
      maxAutomaticTokenAssociations: body.max_automatic_token_associations,
      balance: 0n,
    } as MirrorAccount;
  };
  const relation = { tokenId: testnet.sauce.id, automaticAssociation: false, balance: 1n };

  it("no slot and no relation blocks the send, and says why", async () => {
    const mirror = createMirrorClient({
      transport: replayMirror({
        [mirrorPaths.account("0x82756b984e8c34c28c98a3eb6977df106e4b3aac")]: mirrorFixture(
          "account-zero-slots-unassociated",
        ),
        [mirrorPaths.tokenRelationship("0.0.10574825", testnet.sauce.id)]: mirrorFixture("tokens-no-relation"),
      }),
    });
    const verdict = await checkRecipient(mirror, {
      recipient: "0x82756b984e8c34c28c98a3eb6977df106e4b3aac",
      token: testnet.sauce,
    });
    expect(verdict).toMatchObject({ status: "fail", action: "associate", autoAssociates: false });
    expect(verdict.message).toContain(
      "0.0.10574825 is not associated with SAUCE and has no automatic association slot",
    );
  });

  it("no slot but an explicit relation passes", async () => {
    const mirror = createMirrorClient({
      transport: replayMirror({
        [mirrorPaths.account("0x0a6f9a4407c2e13f55df69a0281e0fa9c9b040de")]: mirrorFixture(
          "account-zero-slots-associated",
        ),
        [mirrorPaths.tokenRelationship("0.0.10650085", testnet.sauce.id)]: mirrorFixture("tokens-relation-explicit"),
      }),
    });
    const verdict = await checkRecipient(mirror, {
      recipient: "0x0a6f9a4407c2e13f55df69a0281e0fa9c9b040de",
      token: testnet.sauce,
    });
    expect(verdict).toMatchObject({ status: "pass", autoAssociates: false });
  });

  it("unlimited slots without a relation pass, and the swap will associate", () => {
    const verdict = recipientVerdict(MAIN, account("account-unlimited-slots"), null, testnet.sauce);
    expect(verdict).toMatchObject({ status: "pass", autoAssociates: true });
  });

  it("limited slots without a relation warn: the mirror does not say how many are free", () => {
    const limited = { ...account("account-zero-slots-unassociated"), maxAutomaticTokenAssociations: 5 };
    const verdict = recipientVerdict("0x82756b984e8c34c28c98a3eb6977df106e4b3aac", limited, null, testnet.sauce);
    expect(verdict).toMatchObject({ status: "warn", action: "associate", autoAssociates: true });
  });

  it("the long-zero form of an account with its own EVM address is refused, naming the address to use", () => {
    const verdict = recipientVerdict(
      "0x0000000000000000000000000000000000a2719a",
      account("account-by-long-zero-address"),
      relation,
      testnet.sauce,
    );
    expect(verdict.status).toBe("fail");
    expect(verdict.message).toContain("has its own EVM address 0x3b7a9a1b874dd0994cc4137047dacf2803bb6c01");
  });

  it("an address with no account is refused", async () => {
    const nobody = `0x${"12".repeat(20)}` as const;
    const mirror = createMirrorClient({
      transport: replayMirror({ [mirrorPaths.account(nobody)]: mirrorFixture("account-not-found") }),
    });
    expect(await checkRecipient(mirror, { recipient: nobody, token: testnet.sauce })).toMatchObject({
      status: "fail",
      action: "fund",
    });
  });
});

describe("facade result: a code other than 22 is a failure inside a successful transaction", () => {
  const associateAbi = parseAbi(["function associate() returns (uint256 responseCode)"]);

  it("the second associate() of 0x6d58…225e succeeded as a transaction and returned 194", () => {
    const { result, call_result } = mirrorFixture("result-associate-again-194").body as Record<string, `0x${string}`>;
    expect(result).toBe("SUCCESS");
    const code = decodeFunctionResult({ abi: associateAbi, functionName: "associate", data: call_result });
    expect(facadeResultVerdict(code)).toEqual({
      check: "facade-result",
      status: "fail",
      action: "none",
      message:
        "The transaction succeeded but the HTS operation returned 194 (TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT). The " +
        "account was already associated with this token: nothing changed, and the call was still charged.",
    });
  });

  it("22 passes", () => {
    expect(facadeResultVerdict(22n).status).toBe("pass");
  });
});

describe("cost: an upper bound from the estimate for this sender and recipient", () => {
  const gasPrice = BigInt(rpcFixture("gas-price").body.result as string);

  it("HBAR -> token for an associated recipient, from the captured estimate and gas price", async () => {
    const swap = buildHbarToTokenSwap({
      pool: testnet.hbarSaucePool,
      recipient: MAIN,
      slippageBps: 500,
      deadline: 1_790_024_196n,
      amountIn: hbarToTinybar("1"),
      quotedAmountOut: 46_434_742n,
    });
    const client = replayClient([rpcFixture("estimate-hbar-to-token"), rpcFixture("gas-price")]);
    const verdict = await checkCost(client, { call: swap, account: MAIN, autoAssociates: false, token: testnet.sauce });
    expect(verdict).toMatchObject({ status: "pass", gas: 214_457n, fee: 214_457n * 114n });
    expect(verdict.message).toBe("Network fee: up to 0.24448098 HBAR.");
  });

  it("names the one-time association when the swap makes one", () => {
    const verdict = costVerdict({ gas: 960_509n, gasPrice, autoAssociates: true, token: testnet.sauce });
    expect(verdict.message).toContain("including the recipient's one-time association with SAUCE");
  });

  it("token -> HBAR: warns when the fee is larger than the HBAR the swap returns", async () => {
    const hbarOut = tinybar(
      await quoteExactInput(
        replayClient([rpcFixture("call-quote-sauce-to-hbar")]),
        swapPath(testnet.sauce, 3000, testnet.whbar),
        TEN_SAUCE,
      ),
    );
    const gas = BigInt(rpcFixture("estimate-token-to-hbar-allowance-zero").body.result as string);
    const verdict = costVerdict({ gas, gasPrice, autoAssociates: false, token: testnet.sauce, hbarOut });
    expect(verdict.status).toBe("warn");
    expect(verdict.message).toBe(
      "Network fee: up to 1.09106664 HBAR. The swap returns 0.21407018 HBAR, less than that fee.",
    );
  });

  it("rounds a fraction of a tinybar up, never down", () => {
    expect(costVerdict({ gas: 1n, gasPrice: 1n, autoAssociates: false, token: testnet.sauce }).fee).toBe(1n);
  });
});
