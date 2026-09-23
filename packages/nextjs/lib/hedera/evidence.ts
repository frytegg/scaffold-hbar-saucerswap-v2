import { type EntityId, testnet } from "./addresses";
import { type EvmAddress, isEvmAddress } from "./evmAddress";
import type { MirrorClient, MirrorContractResult, MirrorTransaction } from "./mirror";
import { mirrorPaths } from "./mirrorPaths";
import { mintValue } from "./position";
import { positionManagerAbi } from "./positionAbi";
import { approvalGranted, swapAmountOut } from "./swap";
import { netTransfer, networkFee } from "./transfers";
import { type Tinybar, formatHbar, tinybar } from "./units";
import { type Hex, decodeAbiParameters, decodeFunctionData, isHex } from "viem";

// A file of docs/evidence/ records one thing the signed evidence runs did on Hedera testnet — a swap, or the life
// cycle of one liquidity position — with what was asked, what the network did, and the software that did it. Nothing
// in it is private. The two check functions re-read every figure from the mirror node, so anyone can verify a file
// without a key. A record that carries a `position` is a life cycle; anything else is a swap.

export const EVIDENCE_SCHEMA_VERSION = 1;

/**
 * What a recorded transaction did. A swap record uses `approve`, `swap` and `deploy`, the creation of the contract a
 * `via` swap went through; a position record uses the calls of a life cycle, `nft-approve` being the approval on the
 * position NFT that a burn needs.
 */
const EVIDENCE_ROLES = ["approve", "swap", "deploy", "nft-approve", "mint", "decrease", "collect", "burn"] as const;

export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

export type EvidenceTransaction = {
  role: EvidenceRole;
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
  recipient: EvmAddress;
  /** exactInput's return value, decoded from the swap's call_result. */
  amountOut: string;
  /** The same two amounts with their unit, for reading. */
  summary: string;
  /**
   * Set when the swap was not sent to the router but to a contract of this repository that swaps on the sender's
   * behalf. The transaction's return value is then that contract's, not the router's multicall's.
   */
  via?: { contract: EntityId; evmAddress: EvmAddress; function: string };
};

export type EvidencePreflight = { check: string; status: string; message: string };

export type EvidenceRecord = {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  name: string;
  network: "testnet";
  chainId: number;
  recordedAt: string;
  sender: { evmAddress: EvmAddress; accountId: EntityId };
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
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isIntegerString = (value: unknown): value is string => typeof value === "string" && /^-?\d+$/.test(value);
const isEntityId = (value: unknown): value is EntityId => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
const isHash = (value: unknown): value is Hex => typeof value === "string" && isHex(value) && value.length === 66;
const oneOf =
  <T extends string>(...allowed: T[]) =>
  (value: unknown): value is T =>
    allowed.includes(value as T);

function parseTransaction(value: unknown, file: string): EvidenceTransaction {
  if (!isObject(value)) throw new EvidenceFormatError(file, "transactions");
  return {
    role: field(value, "role", file, oneOf(...EVIDENCE_ROLES)),
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

function parseVia(value: unknown, file: string): EvidenceSwap["via"] {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new EvidenceFormatError(file, "swap.via");
  return {
    contract: field(value, "contract", file, isEntityId),
    evmAddress: field(value, "evmAddress", file, isEvmAddress),
    function: field(value, "function", file, isString),
  };
}

function parseSwap(value: unknown, file: string): EvidenceSwap {
  if (!isObject(value)) throw new EvidenceFormatError(file, "swap");
  return {
    via: parseVia(value.via, file),
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

/**
 * What the swap paid out, from the transaction's return value: the router's multicall answers the amount inside an
 * array of results, while a contract of this repository answers `(amountOut, refundedTinybar)` of its own.
 */
function amountOutOf(swap: EvidenceSwap, callResult: Hex): bigint {
  if (swap.via === undefined) return swapAmountOut(callResult);
  const [amountOut] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], callResult);
  return amountOut;
}

/** Everything a recorded transaction claims that the mirror node answers on its own, whatever the record is about. */
async function checkAgainstMirror(
  sender: EvidenceRecord["sender"],
  recorded: EvidenceTransaction,
  result: MirrorContractResult,
  mirror: MirrorClient,
): Promise<string[]> {
  const at = `${recorded.role} ${recorded.hash}`;
  const findings: string[] = [];
  const compare = (what: string, onChain: string, inFile: string) => {
    if (onChain !== inFile) findings.push(`${at}: ${what} is ${onChain} on the mirror node, ${inFile} in the file.`);
  };
  compare("the result", result.result, recorded.result);
  compare("the consensus timestamp", result.timestamp, recorded.consensusTimestamp);
  compare("the block", result.blockNumber.toString(), recorded.blockNumber.toString());
  compare("the gas used", result.gasUsed.toString(), recorded.gasUsed.toString());

  // The mirror names the sender in long-zero form: resolve it to its account, then compare the EVM address.
  const from = await mirror.getAccount(result.from);
  compare("the sender's EVM address", from?.evmAddress.toLowerCase() ?? "unknown", sender.evmAddress.toLowerCase());
  compare("the sender's account", from?.accountId ?? "unknown", sender.accountId);

  const transaction = await mirror.getTransaction(result.timestamp);
  if (transaction === null) {
    findings.push(`${at}: the mirror node has no transaction record at ${result.timestamp}.`);
  } else {
    compare("the fee in tinybar", networkFee(transaction.transfers).toString(), recorded.feeTinybar);
    compare(
      "the sender's net HBAR movement in tinybar",
      netTransfer(transaction.transfers, sender.accountId).toString(),
      recorded.senderNetTinybar,
    );
  }
  return findings;
}

/** The return value an HTS approve answers: a transaction that succeeded and approved nothing returns false. */
function checkApprovalReturn(recorded: EvidenceTransaction, result: MirrorContractResult): string[] {
  if (result.callResult === null) {
    return [`${recorded.role} ${recorded.hash}: the mirror node has no return value for this transaction.`];
  }
  if (approvalGranted(result.callResult)) return [];
  return [
    `${recorded.role} ${recorded.hash}: the approval's return value is false on the mirror node, true in the file.`,
  ];
}

async function checkTransaction(
  record: EvidenceRecord,
  recorded: EvidenceTransaction,
  mirror: MirrorClient,
): Promise<string[]> {
  const at = `${recorded.role} ${recorded.hash}`;
  const result = await mirror.getContractResult(recorded.hash);
  if (result === null) return [`${at}: the mirror node has no result for this hash.`];
  const findings = await checkAgainstMirror(record.sender, recorded, result, mirror);

  // A contract creation answers with the runtime bytecode it deployed, which is not a value to compare.
  if (recorded.role === "deploy" || result.result !== "SUCCESS") return findings;
  if (recorded.role === "approve") return [...findings, ...checkApprovalReturn(recorded, result)];
  if (result.callResult === null) {
    findings.push(`${at}: the mirror node has no return value for this transaction.`);
  } else {
    const onChain = amountOutOf(record.swap, result.callResult).toString();
    if (onChain !== record.swap.amountOut) {
      findings.push(
        `${at}: the swap's amountOut is ${onChain} on the mirror node, ${record.swap.amountOut} in the file.`,
      );
    }
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

/**
 * What an account held before or after a position cycle. A fresh account is the interesting case: no allowance for
 * the position manager, no approval on the position NFT and no relation with it, which is the state a first-time
 * user is in and the one the extra two signatures of the cycle are for.
 */
export type EvidenceAccountState = {
  balanceTinybar: string;
  balanceHbar: string;
  /** The pool token's balance, in its own smallest unit. */
  tokenBalance: string;
  /** -1 for unlimited, as the mirror node reports it: an account with none cannot receive the position NFT. */
  maxAutomaticTokenAssociations: number;
  /** Whether the account already had a relation with the position NFT collection. */
  holdsLpNftRelation: boolean;
  /** The position serials the account held, oldest first. */
  positions: string[];
  /** What the position manager was allowed to spend of the pool token. */
  managerAllowance: string;
  /** Whether the position manager could already move the account's positions, which a burn needs. */
  nftApproval: boolean;
};

export type EvidencePosition = {
  manager: EntityId;
  lpNft: EntityId;
  pool: EntityId;
  poolFee: number;
  /** The serial the mint created, and the position every transaction of the record is about. */
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
  /** The pool's own tick and square-root price, read at the block the range and the amounts were computed from. */
  tickAtMint: number;
  sqrtPriceX96AtMint: string;
  /** The liquidity the manager reported for the position once it existed. */
  liquidity: string;
  /** How far under the amounts the range needs at that price the minimums were set. */
  toleranceBps: number;
  amount0Desired: string;
  amount1Desired: string;
  amount0Min: string;
  amount1Min: string;
  /** The factory's fee converted through the exchange-rate system contract, and the value the mint carried. */
  mintFeeTinybar: string;
  mintValueTinybar: string;
  /** What the position holds, from its liquidity at the price it was minted at. */
  depositedHbar: string;
  depositedToken: string;
  /** What the manager owed the position after the decrease, read from `positions` before the collect. */
  collectedHbar: string;
  collectedToken: string;
  /** The HBAR the split collect moved into the account natively, from that transaction's own transfer list. */
  hbarReceivedTinybar: string;
  summary: string;
};

export type PositionEvidenceRecord = {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  name: string;
  network: "testnet";
  chainId: number;
  recordedAt: string;
  sender: { evmAddress: EvmAddress; accountId: EntityId };
  software: { viem: string; relay: string; node: string };
  /** The account before anything was signed, and after the position was burnt. */
  preState: EvidenceAccountState;
  postState: EvidenceAccountState;
  preflight: EvidencePreflight[];
  position: EvidencePosition;
  transactions: EvidenceTransaction[];
};

/** Which of the two shapes a file of docs/evidence/ holds. A swap record has no `position`. */
export function isPositionEvidence(json: unknown): boolean {
  return isObject(json) && isObject(json.position);
}

function parseAccountState(value: unknown, file: string): EvidenceAccountState {
  if (!isObject(value)) throw new EvidenceFormatError(file, "preState or postState");
  const positions = field(value, "positions", file, Array.isArray);
  return {
    balanceTinybar: field(value, "balanceTinybar", file, isIntegerString),
    balanceHbar: field(value, "balanceHbar", file, isString),
    tokenBalance: field(value, "tokenBalance", file, isIntegerString),
    maxAutomaticTokenAssociations: field(value, "maxAutomaticTokenAssociations", file, isInteger),
    holdsLpNftRelation: field(value, "holdsLpNftRelation", file, isBoolean),
    positions: positions.map((serial, index) => {
      if (!isIntegerString(serial)) throw new EvidenceFormatError(file, `positions[${index}]`);
      return serial;
    }),
    managerAllowance: field(value, "managerAllowance", file, isIntegerString),
    nftApproval: field(value, "nftApproval", file, isBoolean),
  };
}

function parsePosition(value: unknown, file: string): EvidencePosition {
  if (!isObject(value)) throw new EvidenceFormatError(file, "position");
  return {
    manager: field(value, "manager", file, isEntityId),
    lpNft: field(value, "lpNft", file, isEntityId),
    pool: field(value, "pool", file, isEntityId),
    poolFee: field(value, "poolFee", file, isInteger),
    tokenId: field(value, "tokenId", file, isIntegerString),
    tickLower: field(value, "tickLower", file, isInteger),
    tickUpper: field(value, "tickUpper", file, isInteger),
    tickSpacing: field(value, "tickSpacing", file, isInteger),
    tickAtMint: field(value, "tickAtMint", file, isInteger),
    sqrtPriceX96AtMint: field(value, "sqrtPriceX96AtMint", file, isIntegerString),
    liquidity: field(value, "liquidity", file, isIntegerString),
    toleranceBps: field(value, "toleranceBps", file, isInteger),
    amount0Desired: field(value, "amount0Desired", file, isIntegerString),
    amount1Desired: field(value, "amount1Desired", file, isIntegerString),
    amount0Min: field(value, "amount0Min", file, isIntegerString),
    amount1Min: field(value, "amount1Min", file, isIntegerString),
    mintFeeTinybar: field(value, "mintFeeTinybar", file, isIntegerString),
    mintValueTinybar: field(value, "mintValueTinybar", file, isIntegerString),
    depositedHbar: field(value, "depositedHbar", file, isIntegerString),
    depositedToken: field(value, "depositedToken", file, isIntegerString),
    collectedHbar: field(value, "collectedHbar", file, isIntegerString),
    collectedToken: field(value, "collectedToken", file, isIntegerString),
    hbarReceivedTinybar: field(value, "hbarReceivedTinybar", file, isIntegerString),
    summary: field(value, "summary", file, isString),
  };
}

/** Reads a position record, refusing a file that is not a whole life cycle: a cycle that left a position open. */
export function parsePositionEvidence(json: unknown, file: string): PositionEvidenceRecord {
  if (!isObject(json)) throw new EvidenceFormatError(file, "the top-level object");
  const sender = field(json, "sender", file, isObject);
  const software = field(json, "software", file, isObject);
  const preflight = field(json, "preflight", file, Array.isArray);
  const transactions = field(json, "transactions", file, Array.isArray);
  const entries = transactions.map(transaction => parseTransaction(transaction, file));
  for (const role of ["mint", "decrease", "collect", "burn"] as const) {
    if (!entries.some(entry => entry.role === role))
      throw new EvidenceFormatError(file, `a transaction with role ${role}`);
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
    preState: parseAccountState(json.preState, file),
    postState: parseAccountState(json.postState, file),
    preflight: preflight.map(verdict => parsePreflight(verdict, file)),
    position: parsePosition(json.position, file),
    transactions: entries,
  };
}

/** The arguments of one call the manager executed, decoded from the calldata that reached consensus. */
function decodedCall(data: Hex | null): { name: string; args: readonly unknown[] } | null {
  if (data === null) return null;
  try {
    const { functionName, args } = decodeFunctionData({ abi: positionManagerAbi, data });
    return { name: functionName, args: args ?? [] };
  } catch {
    // Calldata the position manager's own ABI does not describe: the caller reports it as a transaction that is
    // not the call the record says it is, which is more useful than the decoder's message.
    return null;
  }
}

/** The one inner call of a multicall that runs `name`, so that the mint inside `multicall[mint, refundETH]` is read. */
function innerCall(data: Hex | null, name: string): { name: string; args: readonly unknown[] } | null {
  const outer = decodedCall(data);
  if (outer === null) return null;
  if (outer.name === name) return outer;
  if (outer.name !== "multicall") return null;
  const inner = (outer.args[0] as readonly Hex[] | undefined) ?? [];
  return inner.map(call => decodedCall(call)).find(call => call?.name === name) ?? null;
}

type MintArguments = {
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: string;
};

/** Everything the `position` block claims that the chain answers on its own, on top of the transactions. */
async function checkPositionBlock(
  record: PositionEvidenceRecord,
  results: Map<EvidenceRole, MirrorContractResult>,
  mirror: MirrorClient,
): Promise<string[]> {
  const { position, sender } = record;
  const at = `position ${position.tokenId}`;
  const findings: string[] = [];
  const compare = (what: string, onChain: string, inFile: string) => {
    if (onChain !== inFile) findings.push(`${at}: ${what} is ${onChain} on the mirror node, ${inFile} in the file.`);
  };

  const mint = results.get("mint");
  if (mint !== undefined) {
    compare("the value the mint carried", mint.amount.toString(), position.mintValueTinybar);
    const opened = innerCall(mint.functionParameters, "mint");
    if (opened === null) {
      findings.push(`${at}: the calldata of ${mint.hash} does not run a mint on the position manager.`);
    } else {
      const asked = opened.args[0] as MintArguments;
      compare("the pool fee the mint asked for", asked.fee.toString(), position.poolFee.toString());
      compare("the lower tick the mint asked for", asked.tickLower.toString(), position.tickLower.toString());
      compare("the upper tick the mint asked for", asked.tickUpper.toString(), position.tickUpper.toString());
      compare("amount0Desired in the mint", asked.amount0Desired.toString(), position.amount0Desired);
      compare("amount1Desired in the mint", asked.amount1Desired.toString(), position.amount1Desired);
      compare("amount0Min in the mint", asked.amount0Min.toString(), position.amount0Min);
      compare("amount1Min in the mint", asked.amount1Min.toString(), position.amount1Min);
      compare("the recipient of the position", asked.recipient.toLowerCase(), sender.evmAddress.toLowerCase());
    }
    findings.push(...(await checkMintTransfers(record, mint, mirror)));
  }

  const liquidityTaken = innerCall(results.get("decrease")?.functionParameters ?? null, "decreaseLiquidity");
  if (liquidityTaken === null) {
    findings.push(`${at}: the calldata of the decrease does not run decreaseLiquidity on the position manager.`);
  } else {
    const taken = liquidityTaken.args[0] as { tokenId: bigint; liquidity: bigint };
    compare("the serial the decrease emptied", taken.tokenId.toString(), position.tokenId);
    compare("the liquidity the decrease took out", taken.liquidity.toString(), position.liquidity);
  }

  const burnt = innerCall(results.get("burn")?.functionParameters ?? null, "burn");
  if (burnt === null) findings.push(`${at}: the calldata of the burn does not run burn on the position manager.`);
  else compare("the serial the burn destroyed", String(burnt.args[0]), position.tokenId);

  findings.push(...(await checkSerialLifetime(record, results, mirror)));
  return findings;
}

/** What the mint's own HBAR transfer list paid out: the pool's token wrapper took the deposit, the pool the fee. */
async function checkMintTransfers(
  record: PositionEvidenceRecord,
  mint: MirrorContractResult,
  mirror: MirrorClient,
): Promise<string[]> {
  const { position } = record;
  const at = `position ${position.tokenId}`;
  const transaction = await mirror.getTransaction(mint.timestamp);
  if (transaction === null) return [`${at}: the mirror node has no transaction record for the mint.`];
  const findings: string[] = [];

  const wrapped = netTransfer(transaction.transfers, testnet.whbarContract.id);
  if (wrapped.toString() !== position.depositedHbar) {
    findings.push(
      `${at}: the mint credited ${wrapped} tinybar to ${testnet.whbarContract.id}, which is the HBAR the position ` +
        `deposits, and the file says ${position.depositedHbar}.`,
    );
  }

  // The fee is quoted in tinycent and converted again at execution, so what the pool was credited can be a little
  // above the figure the run read a moment earlier: the margin mintValue adds is exactly how much a mint tolerates.
  const charged = netTransfer(transaction.transfers, position.pool);
  const read = BigInt(position.mintFeeTinybar);
  const mostItCanBe = mintValue({ hbarAmount: tinybar(0n), mintFeeTinybar: tinybar(read) });
  if (charged < read || charged > mostItCanBe) {
    findings.push(
      `${at}: the mint credited ${charged} tinybar to the pool ${position.pool} as its fee, outside the ` +
        `${read} to ${mostItCanBe} tinybar the file's own mint fee allows.`,
    );
  }
  return findings;
}

/** The serial itself: minted by this cycle's mint, destroyed by its burn, and held by nobody afterwards. */
async function checkSerialLifetime(
  record: PositionEvidenceRecord,
  results: Map<EvidenceRole, MirrorContractResult>,
  mirror: MirrorClient,
): Promise<string[]> {
  const { position } = record;
  const at = `position ${position.tokenId}`;
  const serial = await mirror.getNft(position.lpNft, position.tokenId);
  if (serial === null) return [`${at}: ${position.lpNft} has no such serial on the mirror node.`];

  const findings: string[] = [];
  // The mirror node gives the serial its own consensus timestamp, a few nanoseconds after the transaction's own:
  // the second is what identifies the transaction that minted or burnt it.
  const second = (timestamp: string) => timestamp.split(".")[0];
  const sameSecondAs = (role: EvidenceRole, timestamp: string, what: string) => {
    const result = results.get(role);
    if (result === undefined) return;
    if (second(timestamp) !== second(result.timestamp)) {
      findings.push(
        `${at}: the serial was ${what} at ${timestamp} and the cycle's ${role} reached consensus at ${result.timestamp}.`,
      );
    }
  };
  if (!serial.deleted) findings.push(`${at}: the mirror node still has the serial, so it was never burnt.`);
  if (serial.accountId !== null) findings.push(`${at}: ${serial.accountId} holds the serial the cycle burnt.`);
  sameSecondAs("mint", serial.createdTimestamp, "minted");
  sameSecondAs("burn", serial.modifiedTimestamp, "last changed");
  return findings;
}

/**
 * Re-reads a position cycle from the mirror node: every transaction as a swap record's is re-read, the HBAR the
 * split collect paid out natively, everything the `position` block claims that the chain can answer — the value and
 * the calldata of the mint, what its transfer list paid the pool and the token wrapper, the serial's own life and
 * death — and that the account no longer holds the serial. Empty when all of it holds.
 */
export async function checkPositionEvidence(record: PositionEvidenceRecord, mirror: MirrorClient): Promise<string[]> {
  const findings: string[] = [];
  const results = new Map<EvidenceRole, MirrorContractResult>();
  for (const recorded of record.transactions) {
    const at = `${recorded.role} ${recorded.hash}`;
    const result = await mirror.getContractResult(recorded.hash);
    if (result === null) {
      findings.push(`${at}: the mirror node has no result for this hash.`);
      continue;
    }
    findings.push(...(await checkAgainstMirror(record.sender, recorded, result, mirror)));
    if (result.result !== "SUCCESS") continue;
    results.set(recorded.role, result);
    if (recorded.role === "approve") findings.push(...checkApprovalReturn(recorded, result));
    if (recorded.role !== "collect") continue;
    // The collect's own transfer list is what proves the HBAR arrived as HBAR: what the account gained, plus the
    // fee it paid in the same transaction, is the whole payout. A collect that paid WHBAR tokens moves no HBAR.
    const paid = BigInt(recorded.senderNetTinybar) + BigInt(recorded.feeTinybar);
    if (paid.toString() !== record.position.hbarReceivedTinybar) {
      findings.push(
        `${at}: the account's HBAR movement and fee give ${paid} tinybar of native HBAR, ` +
          `${record.position.hbarReceivedTinybar} in the file.`,
      );
    }
  }

  // The unwrap sweeps the manager's whole wrapped balance, so a payout above what the position was owed is a sweep
  // and not a mismatch; a payout below it is a collect that did not pay the position out.
  if (BigInt(record.position.hbarReceivedTinybar) < BigInt(record.position.collectedHbar)) {
    findings.push(
      `position ${record.position.tokenId}: the collect paid ${record.position.hbarReceivedTinybar} tinybar of ` +
        `native HBAR while the manager owed the position ${record.position.collectedHbar}.`,
    );
  }

  findings.push(...(await checkPositionBlock(record, results, mirror)));

  const held = await mirror.getAccountNfts(record.sender.accountId, record.position.lpNft);
  if (held.nfts.some(nft => nft.serialNumber.toString() === record.position.tokenId)) {
    findings.push(
      `position ${record.position.tokenId}: ${record.sender.accountId} still holds it, so the cycle this file ` +
        "records did not close.",
    );
  }
  return findings;
}
