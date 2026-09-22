import { testnet } from "../addresses";
import {
  EvidenceFormatError,
  type EvidenceRecord,
  checkEvidence,
  evidenceFileName,
  evidenceTransaction,
  parseEvidence,
} from "../evidence";
import { type MirrorContractResult, type MirrorTransaction, createMirrorClient } from "../mirror";
import { mirrorPaths } from "../mirrorPaths";
import { approvalGranted, swapAmountOut } from "../swap";
import { netTransfer, networkFee } from "../transfers";
import { tinybar } from "../units";
import { mirrorBody, mirrorFixture, replayMirror } from "./replay";
import { type Hex, encodeFunctionResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

// The research probe's approve and SAUCE -> HBAR swap of 21 Sept 2026 (C12-AP and C12-P), recorded the way the
// evidence run records its own transactions.
const MAIN = { evmAddress: "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01", accountId: "0.0.10645914" } as const;
const MIRROR = "https://testnet.mirrornode.hedera.com";
const APPROVE = mirrorBody("result-approve-success").hash as Hex;
const SWAP = mirrorBody("result-token-to-hbar-success").hash as Hex;
const LONG_ZERO_MAIN = "0x0000000000000000000000000000000000a2719a";

const mirror = createMirrorClient({
  transport: replayMirror({
    [mirrorPaths.contractResult(APPROVE)]: mirrorFixture("result-approve-success"),
    [mirrorPaths.contractResult(SWAP)]: mirrorFixture("result-token-to-hbar-success"),
    [mirrorPaths.contractResult(`0x${"ab".repeat(32)}`)]: mirrorFixture("result-not-found"),
    [mirrorPaths.account(LONG_ZERO_MAIN)]: mirrorFixture("account-by-long-zero-address"),
    [mirrorPaths.transaction("1790023815.578594660")]: mirrorFixture("transaction-approve-success"),
    [mirrorPaths.transaction("1790023842.760213408")]: mirrorFixture("transaction-token-to-hbar-success"),
    [mirrorPaths.transaction("1790023599.459077954")]: mirrorFixture("transaction-hbar-to-token-success"),
    [mirrorPaths.transaction("1790092634.789133757")]: mirrorFixture("transaction-staking-reward-in-record"),
  }),
});

// The probe's gas estimates at 114 tinybar per gas, as the cost preview computes them.
const PREVIEW = { approve: tinybar(782_570n * 114n), swap: tinybar(969_880n * 114n) };

async function entry(role: "approve" | "swap", hash: Hex) {
  const result = (await mirror.getContractResult(hash)) as MirrorContractResult;
  const record = (await mirror.getTransaction(result.timestamp)) as MirrorTransaction;
  return evidenceTransaction({
    role,
    result,
    record,
    sender: MAIN.accountId,
    previewFee: PREVIEW[role],
    mirrorBaseUrl: MIRROR,
  });
}

async function probeRecord(): Promise<EvidenceRecord> {
  return {
    schemaVersion: 1,
    name: "sauce-to-hbar",
    network: "testnet",
    chainId: 296,
    recordedAt: "2026-09-21T20:50:45.000Z",
    sender: MAIN,
    software: { viem: "2.39.0", relay: "relay/0.78.5", node: "v24.13.0" },
    preflight: [{ check: "allowance", status: "fail", message: "The SaucerSwap router has no allowance…" }],
    swap: {
      direction: "token-to-hbar",
      router: testnet.swapRouter.id,
      pool: testnet.hbarSaucePool.id,
      poolFee: 3000,
      tokenIn: "SAUCE 0.0.1183558",
      tokenOut: "HBAR",
      amountIn: "10000000",
      quotedAmountOut: "21407548",
      slippageBps: 500,
      amountOutMinimum: "20337170",
      deadline: "1790024437",
      recipient: MAIN.evmAddress,
      amountOut: "21407548",
      summary: "10 SAUCE -> 0.21407548 HBAR",
    },
    transactions: [await entry("approve", APPROVE), await entry("swap", SWAP)],
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

describe("fees and HBAR movements come from the transaction record's transfer list", () => {
  const transfers = async (consensusTimestamp: string) =>
    ((await mirror.getTransaction(consensusTimestamp)) as MirrorTransaction).transfers;

  it("HBAR -> SAUCE: the sender paid the 1 HBAR it swapped plus the fee, and nothing else", async () => {
    const list = await transfers("1790023599.459077954");
    expect(networkFee(list)).toBe(21_806_104n);
    expect(netTransfer(list, MAIN.accountId)).toBe(-(100_000_000n + 21_806_104n));
  });

  it("SAUCE -> HBAR: net movement plus fee is the native HBAR the WHBAR contract paid out", async () => {
    const list = await transfers("1790023842.760213408");
    const fee = networkFee(list);
    expect(fee).toBe(99_719_740n);
    expect(netTransfer(list, MAIN.accountId) + fee).toBe(21_407_548n);
    expect(netTransfer(list, testnet.whbarContract.id)).toBe(-21_407_548n);
  });

  it("a staking reward that the record pays out of 0.0.800 is not a fee: only credits to system accounts count", async () => {
    // The template's own 0.1 HBAR swap of 22 Sept 2026: its record also paid 0.0.14208 a pending staking reward.
    const list = await transfers("1790092634.789133757");
    expect(netTransfer(list, "0.0.800")).toBe(-1_204_975_275n);
    expect(networkFee(list)).toBe(21_804_796n);
    expect(netTransfer(list, MAIN.accountId)).toBe(-(10_000_000n + 21_804_796n));
  });

  it("an account that is not in the list moved nothing", async () => {
    expect(netTransfer(await transfers("1790023815.578594660"), testnet.swapRouter.id)).toBe(0n);
  });
});

describe("the return values the evidence reads", () => {
  it("a swap multicall's first result is exactInput's amountOut", () => {
    expect(swapAmountOut(mirrorBody("result-token-to-hbar-success").call_result as Hex)).toBe(21_407_548n);
    expect(swapAmountOut(mirrorBody("result-hbar-to-token-success").call_result as Hex)).toBe(46_434_742n);
  });

  it("an HTS approve answers a bool", () => {
    const abi = parseAbi(["function approve(address, uint256) returns (bool)"]);
    expect(approvalGranted(mirrorBody("result-approve-success").call_result as Hex)).toBe(true);
    expect(approvalGranted(encodeFunctionResult({ abi, functionName: "approve", result: false }))).toBe(false);
  });
});

describe("evidenceTransaction", () => {
  it("records the hash, the mirror URL, block, gas, the fee from the transfer list and the sender's net movement", async () => {
    expect(await entry("swap", SWAP)).toEqual({
      role: "swap",
      hash: SWAP,
      mirrorUrl: `${MIRROR}/api/v1/contracts/results/${SWAP}`,
      result: "SUCCESS",
      consensusTimestamp: "1790023842.760213408",
      blockNumber: 40_812_424,
      gasUsed: 914_860,
      previewFeeTinybar: "110566320",
      feeTinybar: "99719740",
      feeHbar: "0.9971974 HBAR",
      senderNetTinybar: "-78312192",
    });
  });

  it("refuses a transaction that did not succeed", async () => {
    const reverted = {
      ...((await mirror.getContractResult(SWAP)) as MirrorContractResult),
      result: "CONTRACT_REVERT_EXECUTED",
    };
    const record = (await mirror.getTransaction("1790023842.760213408")) as MirrorTransaction;
    expect(() =>
      evidenceTransaction({
        role: "swap",
        result: reverted,
        record,
        sender: MAIN.accountId,
        previewFee: PREVIEW.swap,
        mirrorBaseUrl: MIRROR,
      }),
    ).toThrow("ended in CONTRACT_REVERT_EXECUTED: only successful transactions are evidence.");
  });

  it("names the file after the record's UTC date and name", async () => {
    expect(evidenceFileName(await probeRecord())).toBe("2026-09-21-sauce-to-hbar.json");
  });
});

describe("parseEvidence", () => {
  it("reads back a record written as JSON", async () => {
    const record = await probeRecord();
    expect(parseEvidence(JSON.parse(JSON.stringify(record)), "a.json")).toEqual(record);
  });

  it("refuses a record without a swap transaction", async () => {
    const record = await probeRecord();
    const approveOnly = {
      ...record,
      transactions: record.transactions.filter(transaction => transaction.role !== "swap"),
    };
    expect(formatErrorOf(() => parseEvidence(approveOnly, "a.json"))).toBe(
      "a.json is not an evidence record: a transaction with role swap is missing or malformed.",
    );
  });

  it("refuses a transaction recorded with another result than SUCCESS", async () => {
    const record = await probeRecord();
    const failed = { ...record, transactions: [{ ...record.transactions[1], result: "CONTRACT_REVERT_EXECUTED" }] };
    expect(formatErrorOf(() => parseEvidence(failed, "a.json"))).toBe(
      "a.json is not an evidence record: result is missing or malformed.",
    );
  });

  it("refuses an amount that is not an integer string", async () => {
    const record = await probeRecord();
    const fractional = { ...record, swap: { ...record.swap, amountOut: "0.21407548" } };
    expect(formatErrorOf(() => parseEvidence(fractional, "a.json"))).toBe(
      "a.json is not an evidence record: amountOut is missing or malformed.",
    );
  });
});

describe("checkEvidence re-reads every recorded figure from the mirror node", () => {
  it("passes a record that matches the mirror node", async () => {
    expect(await checkEvidence(await probeRecord(), mirror)).toEqual([]);
  });

  it("fails a record whose sender is another account", async () => {
    const record = await probeRecord();
    const other = { ...record, sender: { ...record.sender, evmAddress: `0x${"12".repeat(20)}` as const } };
    expect(await checkEvidence(other, mirror)).toEqual([
      `approve ${APPROVE}: the sender's EVM address is 0x3b7a9a1b874dd0994cc4137047dacf2803bb6c01 on the mirror node, 0x${"12".repeat(20)} in the file.`,
      `swap ${SWAP}: the sender's EVM address is 0x3b7a9a1b874dd0994cc4137047dacf2803bb6c01 on the mirror node, 0x${"12".repeat(20)} in the file.`,
    ]);
  });

  it("fails a record whose fee, gas or amountOut differs from the chain", async () => {
    const record = await probeRecord();
    const [approve, swap] = record.transactions;
    const edited = {
      ...record,
      swap: { ...record.swap, amountOut: "21407549" },
      transactions: [approve, { ...swap, feeTinybar: "1", gasUsed: 1 }],
    };
    expect(await checkEvidence(edited, mirror)).toEqual([
      `swap ${SWAP}: the gas used is 914860 on the mirror node, 1 in the file.`,
      `swap ${SWAP}: the fee in tinybar is 99719740 on the mirror node, 1 in the file.`,
      `swap ${SWAP}: the swap's amountOut is 21407548 on the mirror node, 21407549 in the file.`,
    ]);
  });

  it("fails a hash that the mirror node does not know", async () => {
    const record = await probeRecord();
    const unknown = { ...record, transactions: [{ ...record.transactions[1], hash: `0x${"ab".repeat(32)}` as Hex }] };
    expect(await checkEvidence(unknown, mirror)).toEqual([
      `swap 0x${"ab".repeat(32)}: the mirror node has no result for this hash.`,
    ]);
  });
});
