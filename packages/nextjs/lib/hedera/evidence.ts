import type { EntityId } from "./addresses";
import type { MirrorClient, MirrorContractResult, MirrorTransaction } from "./mirror";
import { mirrorPaths } from "./mirrorPaths";
import { approvalGranted, swapAmountOut } from "./swap";
import { netTransfer, networkFee } from "./transfers";
import { type Tinybar, formatHbar } from "./units";
import { type Address, type Hex, isAddress, isHex } from "viem";

// A file of docs/evidence/ records one swap that the signed evidence run made on Hedera testnet: what was asked, what
// the network did, and the software that did it. Nothing in it is private. checkEvidence re-reads every figure from
// the mirror node, so anyone can verify a file without a key.

export const EVIDENCE_SCHEMA_VERSION = 1;

export type EvidenceTransaction = {
  role: "approve" | "swap";
  hash: Hex;
  /** The mirror node's DETAIL view of the transaction: the machine-checkable proof. */
  mirrorUrl: string;
  /** Only successful transactions are recorded. */
  result: "SUCCESS";
  consensusTimestamp: string;
  blockNumber: number;
  gasUsed: number;
  /** The cost preview shown before signing: an upper bound, from the gas estimate at the current gas price. */
  previewFeeTinybar: string;
  /** What the transaction record credits to the network's fee accounts, in tinybar, and in HBAR for reading. */
  feeTinybar: string;
  feeHbar: string;
  /** The sender's net HBAR movement in the record, fee included, in tinybar. */
  senderNetTinybar: string;
};

export type EvidenceSwap = {
  direction: "hbar-to-token" | "token-to-hbar";
  router: EntityId;
  pool: EntityId;
  poolFee: number;
  tokenIn: string;
  tokenOut: string;
  /** Integer amounts in each token's smallest unit (tinybar for HBAR), as decimal strings. */
  amountIn: string;
  quotedAmountOut: string;
  slippageBps: number;
  amountOutMinimum: string;
  deadline: string;
  recipient: Address;
  /** exactInput's return value, decoded from the swap's call_result. */
  amountOut: string;
  /** The same two amounts with their unit, for reading. */
  summary: string;
};

export type EvidencePreflight = { check: string; status: string; message: string };

export type EvidenceRecord = {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  name: string;
  network: "testnet";
  chainId: number;
  recordedAt: string;
  sender: { evmAddress: Address; accountId: EntityId };
  software: { viem: string; relay: string; node: string };
  /** What the pre-flight checks said before anything was signed. */
  preflight: EvidencePreflight[];
  swap: EvidenceSwap;
  transactions: EvidenceTransaction[];
};

export class EvidenceFormatError extends Error {
  constructor(file: string, field: string) {
    super(`${file} is not an evidence record: ${field} is missing or malformed.`);
    this.name = "EvidenceFormatError";
  }
}

type JsonObject = Record<string, unknown>;

function field<T>(object: JsonObject, key: string, file: string, valid: (value: unknown) => value is T): T {
  const value = object[key];
  if (!valid(value)) throw new EvidenceFormatError(file, key);
  return value;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isIntegerString = (value: unknown): value is string => typeof value === "string" && /^-?\d+$/.test(value);
const isEntityId = (value: unknown): value is EntityId => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
const isEvmAddress = (value: unknown): value is Address => typeof value === "string" && isAddress(value);
const isHash = (value: unknown): value is Hex => typeof value === "string" && isHex(value) && value.length === 66;
const oneOf =
  <T extends string>(...allowed: T[]) =>
  (value: unknown): value is T =>
    allowed.includes(value as T);

function parseTransaction(value: unknown, file: string): EvidenceTransaction {
  if (!isObject(value)) throw new EvidenceFormatError(file, "transactions");
  return {
    role: field(value, "role", file, oneOf("approve", "swap")),
    hash: field(value, "hash", file, isHash),
    mirrorUrl: field(value, "mirrorUrl", file, isString),
    result: field(value, "result", file, oneOf("SUCCESS")),
    consensusTimestamp: field(value, "consensusTimestamp", file, isString),
    blockNumber: field(value, "blockNumber", file, isInteger),
    gasUsed: field(value, "gasUsed", file, isInteger),
    previewFeeTinybar: field(value, "previewFeeTinybar", file, isIntegerString),
    feeTinybar: field(value, "feeTinybar", file, isIntegerString),
    feeHbar: field(value, "feeHbar", file, isString),
    senderNetTinybar: field(value, "senderNetTinybar", file, isIntegerString),
  };
}

function parsePreflight(value: unknown, file: string): EvidencePreflight {
  if (!isObject(value)) throw new EvidenceFormatError(file, "preflight");
  return {
    check: field(value, "check", file, isString),
    status: field(value, "status", file, isString),
    message: field(value, "message", file, isString),
  };
}

function parseSwap(value: unknown, file: string): EvidenceSwap {
  if (!isObject(value)) throw new EvidenceFormatError(file, "swap");
  return {
    direction: field(value, "direction", file, oneOf("hbar-to-token", "token-to-hbar")),
    router: field(value, "router", file, isEntityId),
    pool: field(value, "pool", file, isEntityId),
    poolFee: field(value, "poolFee", file, isInteger),
    tokenIn: field(value, "tokenIn", file, isString),
    tokenOut: field(value, "tokenOut", file, isString),
    amountIn: field(value, "amountIn", file, isIntegerString),
    quotedAmountOut: field(value, "quotedAmountOut", file, isIntegerString),
    slippageBps: field(value, "slippageBps", file, isInteger),
    amountOutMinimum: field(value, "amountOutMinimum", file, isIntegerString),
    deadline: field(value, "deadline", file, isIntegerString),
    recipient: field(value, "recipient", file, isEvmAddress),
    amountOut: field(value, "amountOut", file, isIntegerString),
    summary: field(value, "summary", file, isString),
  };
}

/** Reads one file of docs/evidence/, refusing anything that is not a complete record. */
export function parseEvidence(json: unknown, file: string): EvidenceRecord {
  if (!isObject(json)) throw new EvidenceFormatError(file, "the top-level object");
  const sender = field(json, "sender", file, isObject);
  const software = field(json, "software", file, isObject);
  const preflight = field(json, "preflight", file, Array.isArray);
  const transactions = field(json, "transactions", file, Array.isArray);
  if (!transactions.some(transaction => isObject(transaction) && transaction.role === "swap")) {
    throw new EvidenceFormatError(file, "a transaction with role swap");
  }
  return {
    schemaVersion: field(json, "schemaVersion", file, (value): value is 1 => value === EVIDENCE_SCHEMA_VERSION),
    name: field(json, "name", file, isString),
    network: field(json, "network", file, oneOf("testnet")),
    chainId: field(json, "chainId", file, isInteger),
    recordedAt: field(json, "recordedAt", file, isString),
    sender: {
      evmAddress: field(sender, "evmAddress", file, isEvmAddress),
      accountId: field(sender, "accountId", file, isEntityId),
    },
    software: {
      viem: field(software, "viem", file, isString),
      relay: field(software, "relay", file, isString),
      node: field(software, "node", file, isString),
    },
    preflight: preflight.map(verdict => parsePreflight(verdict, file)),
    swap: parseSwap(json.swap, file),
    transactions: transactions.map(transaction => parseTransaction(transaction, file)),
  };
}

/** docs/evidence/<UTC date of the record>-<name>.json */
export function evidenceFileName(record: Pick<EvidenceRecord, "recordedAt" | "name">): string {
  return `${record.recordedAt.slice(0, 10)}-${record.name}.json`;
}

/** The evidence entry of a successful transaction, with its fee read from its transfer list. */
export function evidenceTransaction({
  role,
  result,
  record,
  sender,
  previewFee,
  mirrorBaseUrl,
}: {
  role: EvidenceTransaction["role"];
  result: MirrorContractResult;
  record: MirrorTransaction;
  sender: EntityId;
  previewFee: Tinybar;
  mirrorBaseUrl: string;
}): EvidenceTransaction {
  if (result.result !== "SUCCESS") {
    throw new Error(`${result.hash} ended in ${result.result}: only successful transactions are evidence.`);
  }
  const fee = networkFee(record.transfers);
  return {
    role,
    hash: result.hash,
    mirrorUrl: `${mirrorBaseUrl}${mirrorPaths.contractResult(result.hash)}`,
    result: "SUCCESS",
    consensusTimestamp: result.timestamp,
    blockNumber: Number(result.blockNumber),
    gasUsed: Number(result.gasUsed),
    previewFeeTinybar: previewFee.toString(),
    feeTinybar: fee.toString(),
    feeHbar: formatHbar(fee),
    senderNetTinybar: netTransfer(record.transfers, sender).toString(),
  };
}

async function checkTransaction(
  record: EvidenceRecord,
  recorded: EvidenceTransaction,
  mirror: MirrorClient,
): Promise<string[]> {
  const at = `${recorded.role} ${recorded.hash}`;
  const result = await mirror.getContractResult(recorded.hash);
  if (result === null) return [`${at}: the mirror node has no result for this hash.`];

  const findings: string[] = [];
  const compare = (what: string, onChain: string, inFile: string) => {
    if (onChain !== inFile) findings.push(`${at}: ${what} is ${onChain} on the mirror node, ${inFile} in the file.`);
  };
  compare("the result", result.result, recorded.result);
  compare("the consensus timestamp", result.timestamp, recorded.consensusTimestamp);
  compare("the block", result.blockNumber.toString(), recorded.blockNumber.toString());
  compare("the gas used", result.gasUsed.toString(), recorded.gasUsed.toString());

  // The mirror names the sender in long-zero form: resolve it to its account, then compare the EVM address.
  const sender = await mirror.getAccount(result.from);
  compare(
    "the sender's EVM address",
    sender?.evmAddress.toLowerCase() ?? "unknown",
    record.sender.evmAddress.toLowerCase(),
  );
  compare("the sender's account", sender?.accountId ?? "unknown", record.sender.accountId);

  const transaction = await mirror.getTransaction(result.timestamp);
  if (transaction === null) {
    findings.push(`${at}: the mirror node has no transaction record at ${result.timestamp}.`);
  } else {
    compare("the fee in tinybar", networkFee(transaction.transfers).toString(), recorded.feeTinybar);
    compare(
      "the sender's net HBAR movement in tinybar",
      netTransfer(transaction.transfers, record.sender.accountId).toString(),
      recorded.senderNetTinybar,
    );
  }

  if (result.callResult === null) {
    findings.push(`${at}: the mirror node has no return value for this transaction.`);
  } else if (result.result === "SUCCESS" && recorded.role === "approve") {
    compare("the approval's return value", String(approvalGranted(result.callResult)), "true");
  } else if (result.result === "SUCCESS") {
    compare("the swap's amountOut", swapAmountOut(result.callResult).toString(), record.swap.amountOut);
  }
  return findings;
}

/**
 * Re-reads every transaction of a record from the mirror node: SUCCESS, sent by the recorded account (resolved through
 * its EVM address), and the same block, gas, fee, HBAR movement and amounts as the file says. Empty when all of it holds.
 */
export async function checkEvidence(record: EvidenceRecord, mirror: MirrorClient): Promise<string[]> {
  const findings: string[] = [];
  for (const transaction of record.transactions)
    findings.push(...(await checkTransaction(record, transaction, mirror)));
  return findings;
}
