import { type EntityId, testnet } from "../addresses";
import type { EvmAddress } from "../evmAddress";
import { createMirrorClient } from "../mirror";
import { mirrorPaths } from "../mirrorPaths";
import { mintValue } from "../position";
import {
  checkPositionBurn,
  checkPositionMint,
  lpNftSlotVerdict,
  managerAllowanceVerdict,
  minimumsVerdict,
  mintValueVerdict,
  nftApprovalVerdict,
} from "../positionPreflight";
import { tinybar, toWeibar } from "../units";
import {
  type LifecycleFixture,
  mirrorFixture,
  positionFixture,
  replayClient,
  replayMirror,
  rpcFixture,
} from "./replay";
import { describe, expect, it } from "vitest";

const MAIN: EvmAddress = "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01";
/** A third party that holds positions of this collection and has approved the manager on none of them. */
const HOLDER: EvmAddress = "0x0000000000000000000000000000000000a0dd62";
const MINT_FEE = tinybar(64_079_561n);
const HBAR_LEG = tinybar(100_000_000n);

const account = (fixture: string) => mirrorFixture(fixture);
const mirrorFor = (accountFixture: string, relation: string, accountId: EntityId) =>
  createMirrorClient({
    transport: replayMirror({
      [mirrorPaths.account(MAIN)]: account(accountFixture),
      [mirrorPaths.tokenRelationship(accountId, testnet.lpNft.id)]: mirrorFixture(relation),
    }),
  });

describe("the allowance a mint needs, which is the position manager's and not the router's", () => {
  it("passes when it covers the whole amount the position deposits", () => {
    const verdict = managerAllowanceVerdict(20_000_000n, 20_000_000n, testnet.sauce);
    expect(verdict).toMatchObject({ check: "manager-allowance", status: "pass", action: "none" });
  });

  it("blocks with no allowance, and names the manager rather than the router", () => {
    const verdict = managerAllowanceVerdict(0n, 20_000_000n, testnet.sauce);
    expect(verdict.status).toBe("fail");
    expect(verdict.action).toBe("approve");
    expect(verdict.message).toContain(testnet.positionManager.evmAddress);
    expect(verdict.message).toContain("no allowance");
  });

  it("blocks an allowance that is merely too small, and says how small", () => {
    const verdict = managerAllowanceVerdict(10_000_000n, 20_000_000n, testnet.sauce);
    expect(verdict.status).toBe("fail");
    expect(verdict.message).toContain("10 SAUCE");
    expect(verdict.message).toContain("20 SAUCE");
  });
});

describe("room for the position NFT", () => {
  it("passes an account that already holds positions of this collection", () => {
    const relation = { tokenId: testnet.lpNft.id as EntityId, automaticAssociation: true, balance: 2n };
    const verdict = lpNftSlotVerdict(
      {
        accountId: "0.0.10542434" as EntityId,
        evmAddress: MAIN,
        maxAutomaticTokenAssociations: 0,
        balance: tinybar(0n),
      },
      relation,
    );
    expect(verdict).toMatchObject({ check: "lp-nft-slot", status: "pass" });
  });

  it("blocks an account with no slot and no relation, and names the token to associate", () => {
    const verdict = lpNftSlotVerdict(
      {
        accountId: "0.0.10574825" as EntityId,
        evmAddress: MAIN,
        maxAutomaticTokenAssociations: 0,
        balance: tinybar(0n),
      },
      null,
    );
    expect(verdict.status).toBe("fail");
    expect(verdict.action).toBe("associate");
    expect(verdict.message).toContain(testnet.lpNft.id);
  });

  it("passes an account with unlimited slots and warns about a limited one, which the mirror cannot count", () => {
    const base = { accountId: "0.0.10645914" as EntityId, evmAddress: MAIN, balance: tinybar(0n) };
    expect(lpNftSlotVerdict({ ...base, maxAutomaticTokenAssociations: -1 }, null).status).toBe("pass");
    // No testnet account with a finite non-zero budget has been met, so the limited case is built by hand.
    expect(lpNftSlotVerdict({ ...base, maxAutomaticTokenAssociations: 5 }, null)).toMatchObject({
      status: "warn",
      action: "associate",
    });
  });

  it("blocks an address no account exists at", () => {
    expect(lpNftSlotVerdict(null, null)).toMatchObject({ status: "fail", action: "fund" });
  });
});

describe("the approval a burn needs", () => {
  it("passes when the manager may move the position", () => {
    expect(nftApprovalVerdict(true)).toMatchObject({ check: "nft-approval", status: "pass", action: "none" });
  });

  it("blocks without it, and says why simulation does not catch it", () => {
    const verdict = nftApprovalVerdict(false);
    expect(verdict.status).toBe("fail");
    expect(verdict.action).toBe("approve");
    expect(verdict.message).toContain("HederaFail(292)");
  });

  it("reads the answer from the NFT facade, and reports whichever answer came back", async () => {
    const granted = replayClient([rpcFixture("call-lp-nft-approved")]);
    expect(await checkPositionBurn(granted, MAIN)).toMatchObject({ check: "nft-approval", status: "pass" });
    // The other branch, against an account that holds positions and has approved nothing: a check that stopped
    // reading the chain and answered pass would let the signed run send the HederaFail(292) this whole section is
    // about, and nothing else in the cycle would go red.
    const refused = replayClient([rpcFixture("call-lp-nft-not-approved")]);
    expect(await checkPositionBurn(refused, HOLDER)).toMatchObject({
      check: "nft-approval",
      status: "fail",
      action: "approve",
    });
  });
});

describe("the value a mint has to carry", () => {
  const value = toWeibar(mintValue({ hbarAmount: HBAR_LEG, mintFeeTinybar: MINT_FEE }));

  it("passes the value this template builds, and names the margin refundETH returns", () => {
    const verdict = mintValueVerdict({ value, hbarAmount: HBAR_LEG, mintFeeTinybar: MINT_FEE });
    expect(verdict).toMatchObject({ check: "mint-value", status: "pass" });
    expect(verdict.message).toContain("margin that refundETH returns");
  });

  it("blocks a value that does not cover the deposit and the fee, and names where the value comes from", () => {
    const verdict = mintValueVerdict({ value: toWeibar(HBAR_LEG), hbarAmount: HBAR_LEG, mintFeeTinybar: MINT_FEE });
    expect(verdict.status).toBe("fail");
    expect(verdict.message).toContain("mintValue in lib/hedera/position.ts");
  });

  it("warns on a value with no margin at all, because the fee is converted again at execution", () => {
    const exact = toWeibar(tinybar(HBAR_LEG + MINT_FEE));
    expect(mintValueVerdict({ value: exact, hbarAmount: HBAR_LEG, mintFeeTinybar: MINT_FEE }).status).toBe("warn");
  });

  it("carries the value the mint of position 360 carried", () => {
    const lifecycle = positionFixture<LifecycleFixture>("serial-360-lifecycle");
    const mint = lifecycle.transactions.find(transaction => transaction.step === "mint");
    if (mint === undefined) throw new Error("the life-cycle fixture holds the mint");
    expect(value).toBe(toWeibar(tinybar(BigInt(mint.valueTinybar))));
  });
});

describe("the minimums a call accepts", () => {
  it("passes a call with a floor on either side", () => {
    expect(minimumsVerdict({ amount0Min: 1n, amount1Min: 0n })).toMatchObject({ check: "minimums", status: "pass" });
  });

  it("blocks two zero minimums, and warns instead when the caller asked for them", () => {
    expect(minimumsVerdict({ amount0Min: 0n, amount1Min: 0n })).toMatchObject({ status: "fail", action: "requote" });
    expect(minimumsVerdict({ amount0Min: 0n, amount1Min: 0n, acceptAnyPrice: true }).status).toBe("warn");
  });
});

describe("the whole pre-flight of a mint", () => {
  const client = replayClient([rpcFixture("call-manager-allowance")]);

  it("runs every check against the reads, and blocks nothing for an account that is ready", async () => {
    const verdicts = await checkPositionMint({
      client,
      mirror: mirrorFor("account-unlimited-slots", "tokens-relation-automatic", "0.0.10645914"),
      owner: MAIN,
      token: testnet.sauce,
      tokenAmount: 20_000_000n,
      value: toWeibar(mintValue({ hbarAmount: HBAR_LEG, mintFeeTinybar: MINT_FEE })),
      hbarAmount: HBAR_LEG,
      mintFeeTinybar: MINT_FEE,
      minimums: { amount0Min: 1n, amount1Min: 1n },
    });
    expect(verdicts.map(verdict => verdict.check)).toEqual([
      "manager-allowance",
      "lp-nft-slot",
      "mint-value",
      "minimums",
    ]);
    expect(verdicts.filter(verdict => verdict.status === "fail")).toEqual([]);
  });

  it("blocks on the allowance when the position asks for more than the manager may spend", async () => {
    const verdicts = await checkPositionMint({
      client,
      mirror: mirrorFor("account-unlimited-slots", "tokens-relation-automatic", "0.0.10645914"),
      owner: MAIN,
      token: testnet.sauce,
      tokenAmount: 2n ** 40n,
      value: toWeibar(mintValue({ hbarAmount: HBAR_LEG, mintFeeTinybar: MINT_FEE })),
      hbarAmount: HBAR_LEG,
      mintFeeTinybar: MINT_FEE,
      minimums: { amount0Min: 1n, amount1Min: 1n },
    });
    expect(verdicts.filter(verdict => verdict.status === "fail").map(verdict => verdict.check)).toEqual([
      "manager-allowance",
    ]);
  });
});
