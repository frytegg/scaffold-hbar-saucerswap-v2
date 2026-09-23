import { testnet } from "../addresses";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceAccountState,
  EvidenceFormatError,
  type EvidencePosition,
  type EvidenceRole,
  type EvidenceTransaction,
  type PositionEvidenceRecord,
  checkPositionEvidence,
  evidenceFileName,
  evidenceTransaction,
  isPositionEvidence,
  parseEvidence,
  parsePositionEvidence,
} from "../evidence";
import { type MirrorClient, createMirrorClient } from "../mirror";
import { mirrorPaths } from "../mirrorPaths";
import { type Tinybar, tinybar } from "../units";
import { mirrorBody, mirrorFixture, replayMirror } from "./replay";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";

// The life cycle of position 360, which a browser wallet executed on Hedera testnet on 22 Sept 2026 and the mirror
// node still answers for: four transactions, the collect that paid 25,412,098 tinybar of native HBAR, and an account
// that holds no position afterwards. Recorded here the way the signed cycle records its own, and re-read keylessly.

const MAIN = { evmAddress: "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01", accountId: "0.0.10645914" } as const;
const LONG_ZERO_MAIN = "0x0000000000000000000000000000000000a2719a";
const STEPS = ["mint", "decrease", "collect", "burn"] as const;
const OWED_HBAR = "25412098";
const OWED_SAUCE = "20000000";

const hashOf = (step: (typeof STEPS)[number]) => mirrorBody(`result-position-${step}`).hash as Hex;
const timestampOf = (step: (typeof STEPS)[number]) => mirrorBody(`result-position-${step}`).timestamp as string;

function mirrorWith(nfts: string): MirrorClient {
  return createMirrorClient({
    transport: replayMirror({
      ...Object.fromEntries(
        STEPS.flatMap(step => [
          [mirrorPaths.contractResult(hashOf(step)), mirrorFixture(`result-position-${step}`)],
          [mirrorPaths.transaction(timestampOf(step)), mirrorFixture(`transaction-position-${step}`)],
        ]),
      ),
      [mirrorPaths.account(LONG_ZERO_MAIN)]: mirrorFixture("account-by-long-zero-address"),
      [mirrorPaths.accountNfts(MAIN.accountId, testnet.lpNft.id, 100)]: mirrorFixture(nfts),
    }),
  });
}

const mirror = mirrorWith("nfts-none");

/** The wallet priced every one of these at its gas limit: the preview a record keeps is that upper bound. */
const PREVIEW: Record<(typeof STEPS)[number], Tinybar> = {
  mint: tinybar(285_000_000n),
  decrease: tinybar(23_255_316n),
  collect: tinybar(107_571_312n),
  burn: tinybar(9_713_598n),
};

async function transactionsOf(mirrorClient: MirrorClient): Promise<EvidenceTransaction[]> {
  const entries: EvidenceTransaction[] = [];
  for (const step of STEPS) {
    const result = await mirrorClient.getContractResult(hashOf(step));
    const record = await mirrorClient.getTransaction(timestampOf(step));
    if (result === null || record === null) throw new Error(`the ${step} fixture is missing`);
    entries.push(
      evidenceTransaction({
        role: step as EvidenceRole,
        result,
        record,
        sender: MAIN.accountId,
        previewFee: PREVIEW[step],
        mirrorBaseUrl: "https://testnet.mirrornode.hedera.com",
      }),
    );
  }
  return entries;
}

const state = (fields: Partial<EvidenceAccountState> = {}): EvidenceAccountState => ({
  balanceTinybar: "91401278478",
  balanceHbar: "914.01278478 HBAR",
  tokenBalance: "279000000",
  maxAutomaticTokenAssociations: -1,
  holdsLpNftRelation: true,
  positions: [],
  managerAllowance: "20000000",
  nftApproval: true,
  ...fields,
});

const position: EvidencePosition = {
  manager: testnet.positionManager.id,
  lpNft: testnet.lpNft.id,
  pool: testnet.hbarSaucePool.id,
  poolFee: testnet.hbarSaucePool.fee,
  tokenId: "360",
  tickLower: -7680,
  tickUpper: -7620,
  tickSpacing: 60,
  tickAtMint: -7643,
  sqrtPriceX96AtMint: "54140056176914625121425215591",
  liquidity: "15562884336",
  toleranceBps: 1_000,
  amount0Desired: "27953308",
  amount1Desired: "22000000",
  amount0Min: "22870889",
  amount1Min: "18000000",
  mintFeeTinybar: "64079561",
  mintValueTinybar: "165361153",
  depositedHbar: "25412099",
  depositedToken: OWED_SAUCE,
  collectedHbar: OWED_HBAR,
  collectedToken: OWED_SAUCE,
  hbarReceivedTinybar: OWED_HBAR,
  summary: "0.25412099 HBAR and 20 SAUCE into position 360, 0.25412098 HBAR and 20 SAUCE back out",
};

async function cycleRecord(mirrorClient: MirrorClient = mirror): Promise<PositionEvidenceRecord> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    name: "position-cycle-360",
    network: "testnet",
    chainId: testnet.chainId,
    recordedAt: "2026-09-22T20:52:38.000Z",
    sender: MAIN,
    software: { viem: "2.39.0", relay: "relay/0.78.5", node: "v24.13.0" },
    preState: state({ positions: [] }),
    postState: state(),
    preflight: [{ check: "mint-value", status: "pass", message: "The transaction carries 1.65361153 HBAR." }],
    position,
    transactions: await transactionsOf(mirrorClient),
  };
}

function formatErrorOf(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof EvidenceFormatError) return error.message;
    throw error;
  }
  throw new Error("expected an EvidenceFormatError");
}

describe("a record of a position life cycle", () => {
  it("is told apart from a swap record by what it carries", () => {
    expect(isPositionEvidence({ position: { tokenId: "360" } })).toBe(true);
    expect(isPositionEvidence({ swap: { direction: "hbar-to-token" } })).toBe(false);
    expect(isPositionEvidence("not a record")).toBe(false);
  });

  it("is named after the day and the position it opened", async () => {
    expect(evidenceFileName(await cycleRecord())).toBe("2026-09-22-position-cycle-360.json");
  });

  it("survives a round trip through its own parser", async () => {
    const record = await cycleRecord();
    expect(parsePositionEvidence(JSON.parse(JSON.stringify(record)), "a.json")).toEqual(record);
  });

  it("re-reads clean from the mirror node: four transactions, and the position is gone", async () => {
    expect(await checkPositionEvidence(await cycleRecord(), mirror)).toEqual([]);
  });

  it("names the four figures the mirror node gives for the mint", async () => {
    const [mint] = (await cycleRecord()).transactions;
    expect(mint).toMatchObject({
      role: "mint",
      hash: hashOf("mint"),
      result: "SUCCESS",
      blockNumber: 40_854_606,
      gasUsed: 759_459,
      feeTinybar: "82781031",
      feeHbar: "0.82781031 HBAR",
      senderNetTinybar: "-172272692",
    });
  });
});

describe("what a position record is checked against", () => {
  it("fails a cycle whose collect paid another amount than the file claims", async () => {
    const record = await cycleRecord();
    const edited = { ...record, position: { ...record.position, hbarReceivedTinybar: "25412099" } };
    expect(await checkPositionEvidence(edited, mirror)).toEqual([
      `collect ${hashOf("collect")}: the account's HBAR movement and fee give 25412098 tinybar of native HBAR, ` +
        "25412099 in the file.",
    ]);
  });

  it("fails a cycle that left the position on the account", async () => {
    // The same four transactions, read against an account that still holds serials 357 and 358.
    const stillHeld = mirrorWith("nfts-two-positions");
    const record = await cycleRecord(stillHeld);
    const open = { ...record, position: { ...record.position, tokenId: "358" } };
    expect(await checkPositionEvidence(open, stillHeld)).toEqual([
      "position 358: 0.0.10645914 still holds it, so the cycle this file records did not close.",
    ]);
  });

  it("fails a transaction the mirror node does not know", async () => {
    const record = await cycleRecord();
    const unknown = { ...record, transactions: [{ ...record.transactions[3], hash: `0x${"ab".repeat(32)}` as Hex }] };
    const withoutResult = createMirrorClient({
      transport: replayMirror({
        [mirrorPaths.contractResult(`0x${"ab".repeat(32)}`)]: mirrorFixture("result-not-found"),
        [mirrorPaths.accountNfts(MAIN.accountId, testnet.lpNft.id, 100)]: mirrorFixture("nfts-none"),
      }),
    });
    expect(await checkPositionEvidence(unknown, withoutResult)).toEqual([
      `burn 0x${"ab".repeat(32)}: the mirror node has no result for this hash.`,
    ]);
  });
});

describe("what a position record refuses to be", () => {
  it.each(["mint", "decrease", "collect", "burn"])("refuses a cycle with no %s", async role => {
    const record = await cycleRecord();
    const without = { ...record, transactions: record.transactions.filter(entry => entry.role !== role) };
    expect(formatErrorOf(() => parsePositionEvidence(JSON.parse(JSON.stringify(without)), "a.json"))).toBe(
      `a.json is not an evidence record: a transaction with role ${role} is missing or malformed.`,
    );
  });

  it("refuses a pre-state that does not say what the account could receive", async () => {
    const record = await cycleRecord();
    const { maxAutomaticTokenAssociations, ...rest } = record.preState;
    expect(maxAutomaticTokenAssociations).toBe(-1);
    const edited = JSON.parse(JSON.stringify({ ...record, preState: rest }));
    expect(formatErrorOf(() => parsePositionEvidence(edited, "a.json"))).toBe(
      "a.json is not an evidence record: maxAutomaticTokenAssociations is missing or malformed.",
    );
  });

  it("refuses a serial that is not a whole number", async () => {
    const record = await cycleRecord();
    const edited = JSON.parse(JSON.stringify({ ...record, position: { ...record.position, tokenId: "360.5" } }));
    expect(formatErrorOf(() => parsePositionEvidence(edited, "a.json"))).toBe(
      "a.json is not an evidence record: tokenId is missing or malformed.",
    );
  });

  it("refuses to read a position record as a swap", async () => {
    const record = JSON.parse(JSON.stringify(await cycleRecord()));
    expect(formatErrorOf(() => parseEvidence(record, "a.json"))).toBe(
      "a.json is not an evidence record: a transaction with role swap is missing or malformed.",
    );
  });
});
