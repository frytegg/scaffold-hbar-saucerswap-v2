import type { EntityId } from "./addresses";
import { MIRROR_RELAY_ROUTE, mirrorPaths } from "./mirrorPaths";
import { type Tinybar, tinybar } from "./units";
import { type Address, type Hex, isAddress, isHex } from "viem";

type AccountRef = EntityId | Address;

/** One answer of the mirror node: its HTTP status and its JSON body (null when the body was not JSON). */
export type MirrorResponse = { status: number; body: unknown };

/**
 * Sends one GET. It resolves whenever the mirror node answered, whatever the status, and throws a MirrorError with
 * reason "unavailable" when there was no answer at all.
 */
export type MirrorTransport = (path: string) => Promise<MirrorResponse>;

export type MirrorErrorReason = "refused" | "unavailable" | "timeout" | "unexpected-body";

export class MirrorError extends Error {
  readonly reason: MirrorErrorReason;
  readonly path: string;
  readonly status: number | null;

  constructor(reason: MirrorErrorReason, path: string, status: number | null, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MirrorError";
    this.reason = reason;
    this.path = path;
    this.status = status;
  }
}

export type MirrorContractResult = {
  hash: Hex;
  /** "SUCCESS" or the Hedera status of the failure, e.g. "CONTRACT_REVERT_EXECUTED". */
  result: string;
  /** Raw revert data ("0x" when a multicall dropped it), or null on success. */
  errorMessage: string | null;
  callResult: Hex | null;
  /** The sender in long-zero form, even for an account with an EVM address of its own: compare account ids. */
  from: Address;
  gasUsed: bigint;
  amount: Tinybar;
  blockNumber: bigint;
  /** The consensus timestamp, "seconds.nanoseconds": the key of the transaction record. */
  timestamp: string;
};

/** One line of a transaction record's HBAR transfer list: a signed amount, negative for the account that paid. */
export type MirrorTransfer = { account: EntityId; amount: bigint };

/** The part of a transaction record this library reads. */
export type MirrorTransaction = { transfers: MirrorTransfer[] };

export type MirrorContractAction = {
  callDepth: number;
  resultDataType: string;
  resultData: Hex | null;
};

export type MirrorAccount = {
  accountId: EntityId;
  /** The account's own EVM address when it has one, its long-zero address otherwise: pass this as a recipient. */
  evmAddress: Address;
  /** -1 for unlimited automatic associations, 0 for none. */
  maxAutomaticTokenAssociations: number;
  balance: Tinybar;
};

export type MirrorTokenRelationship = {
  tokenId: EntityId;
  automaticAssociation: boolean;
  balance: bigint;
};

export type WaitOptions = { timeoutMs?: number; intervalMs?: number };

export type MirrorClient = {
  /** The DETAIL view: null while the mirror has not ingested the transaction (it answers 404 until then). */
  getContractResult(hash: Hex): Promise<MirrorContractResult | null>;
  getContractActions(hash: Hex): Promise<MirrorContractAction[]>;
  getAccount(account: AccountRef): Promise<MirrorAccount | null>;
  getTokenRelationship(account: AccountRef, token: EntityId): Promise<MirrorTokenRelationship | null>;
  /** 0 when there is no allowance row: the mirror drops the row once an allowance is used up. */
  getTokenAllowance(owner: AccountRef, spender: EntityId, token: EntityId): Promise<bigint>;
  /** The record at a contract result's `timestamp`; null while the mirror has not ingested it. */
  getTransaction(consensusTimestamp: string): Promise<MirrorTransaction | null>;
  waitForResult(hash: Hex, options?: WaitOptions): Promise<MirrorContractResult>;
};

export type MirrorClientOptions = {
  transport: MirrorTransport;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** Waits before each retry of a 429, a 5xx or a request that got no answer. A 4xx is never retried. */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];
const DEFAULT_WAIT: Required<WaitOptions> = { timeoutMs: 30_000, intervalMs: 1_000 };
const DIRECT_TIMEOUT_MS = 8_000;

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

type JsonObject = Record<string, unknown>;

function unexpected(path: string, what: string): MirrorError {
  return new MirrorError("unexpected-body", path, 200, `The mirror node's answer to ${path} has no valid ${what}.`);
}

function objectAt(value: unknown, path: string, what: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw unexpected(path, what);
  return value as JsonObject;
}

function stringAt(object: JsonObject, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== "string") throw unexpected(path, key);
  return value;
}

function integerAt(object: JsonObject, key: string, path: string): bigint {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw unexpected(path, key);
  return BigInt(value);
}

function hexAt(object: JsonObject, key: string, path: string): Hex {
  const value = object[key];
  if (typeof value !== "string" || !isHex(value)) throw unexpected(path, key);
  return value;
}

function optionalHexAt(object: JsonObject, key: string, path: string): Hex | null {
  return object[key] === null || object[key] === undefined ? null : hexAt(object, key, path);
}

function addressAt(object: JsonObject, key: string, path: string): Address {
  const value = object[key];
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw unexpected(path, key);
  return value;
}

function entityIdAt(object: JsonObject, key: string, path: string): EntityId {
  const value = stringAt(object, key, path);
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw unexpected(path, key);
  return value as EntityId;
}

function arrayAt(object: JsonObject, key: string, path: string): unknown[] {
  const value = object[key];
  if (!Array.isArray(value)) throw unexpected(path, key);
  return value;
}

function parseContractResult(body: unknown, path: string): MirrorContractResult {
  const result = objectAt(body, path, "contract result");
  const errorMessage = result.error_message;
  if (errorMessage !== null && errorMessage !== undefined && typeof errorMessage !== "string") {
    throw unexpected(path, "error_message");
  }
  return {
    hash: hexAt(result, "hash", path),
    result: stringAt(result, "result", path),
    errorMessage: errorMessage ?? null,
    callResult: optionalHexAt(result, "call_result", path),
    from: addressAt(result, "from", path),
    gasUsed: integerAt(result, "gas_used", path),
    amount: tinybar(integerAt(result, "amount", path)),
    blockNumber: integerAt(result, "block_number", path),
    timestamp: stringAt(result, "timestamp", path),
  };
}

function parseTransfer(value: unknown, path: string): MirrorTransfer {
  const transfer = objectAt(value, path, "transfer");
  return { account: entityIdAt(transfer, "account", path), amount: integerAt(transfer, "amount", path) };
}

function parseTransaction(value: unknown, path: string): MirrorTransaction {
  const transaction = objectAt(value, path, "transaction");
  return { transfers: arrayAt(transaction, "transfers", path).map(transfer => parseTransfer(transfer, path)) };
}

function parseAction(value: unknown, path: string): MirrorContractAction {
  const action = objectAt(value, path, "action");
  return {
    callDepth: Number(integerAt(action, "call_depth", path)),
    resultDataType: stringAt(action, "result_data_type", path),
    resultData: optionalHexAt(action, "result_data", path),
  };
}

function parseAccount(body: unknown, path: string): MirrorAccount {
  const account = objectAt(body, path, "account");
  const balance = objectAt(account.balance, path, "balance");
  return {
    accountId: entityIdAt(account, "account", path),
    evmAddress: addressAt(account, "evm_address", path),
    maxAutomaticTokenAssociations: Number(integerAt(account, "max_automatic_token_associations", path)),
    balance: tinybar(integerAt(balance, "balance", path)),
  };
}

function parseTokenRelationship(value: unknown, path: string): MirrorTokenRelationship {
  const relationship = objectAt(value, path, "token relationship");
  return {
    tokenId: entityIdAt(relationship, "token_id", path),
    automaticAssociation: relationship.automatic_association === true,
    balance: integerAt(relationship, "balance", path),
  };
}

function mirrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const messages = (body as { _status?: { messages?: { message?: unknown }[] } })._status?.messages;
  const message = messages?.[0]?.message;
  return typeof message === "string" ? message : null;
}

export function createMirrorClient({ transport, sleep = wait, now = Date.now }: MirrorClientOptions): MirrorClient {
  async function answerOrNothing(path: string): Promise<MirrorResponse | null> {
    try {
      return await transport(path);
    } catch (error: unknown) {
      if (error instanceof MirrorError && error.reason === "unavailable") return null;
      throw error;
    }
  }

  async function get(path: string): Promise<MirrorResponse> {
    for (let attempt = 0; ; attempt++) {
      const response = await answerOrNothing(path);
      if (response !== null && response.status !== 429 && response.status < 500) return response;
      if (attempt === RETRY_DELAYS_MS.length) {
        const answer = response === null ? "no answer" : `HTTP ${response.status}`;
        throw new MirrorError(
          "unavailable",
          path,
          response?.status ?? null,
          `The mirror node is unavailable (${answer} after ${attempt + 1} attempts).`,
        );
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  /** The body of a 200, null for a 404, and a refusal for any other status. */
  async function getFound(path: string): Promise<unknown | null> {
    const { status, body } = await get(path);
    if (status === 200) return body;
    if (status === 404) return null;
    const reason = mirrorMessage(body);
    throw new MirrorError(
      "refused",
      path,
      status,
      `The mirror node refused ${path}: HTTP ${status}${reason ? `, ${reason}` : ""}.`,
    );
  }

  async function getList(path: string, key: string): Promise<unknown[]> {
    const body = await getFound(path);
    return body === null ? [] : arrayAt(objectAt(body, path, key), key, path);
  }

  async function getContractResult(hash: Hex): Promise<MirrorContractResult | null> {
    const path = mirrorPaths.contractResult(hash);
    const body = await getFound(path);
    return body === null ? null : parseContractResult(body, path);
  }

  return {
    getContractResult,

    async getContractActions(hash) {
      const path = mirrorPaths.contractActions(hash);
      return (await getList(path, "actions")).map(action => parseAction(action, path));
    },

    async getAccount(account) {
      const path = mirrorPaths.account(account);
      const body = await getFound(path);
      return body === null ? null : parseAccount(body, path);
    },

    async getTokenRelationship(account, token) {
      const path = mirrorPaths.tokenRelationship(account, token);
      const [first] = await getList(path, "tokens");
      return first === undefined ? null : parseTokenRelationship(first, path);
    },

    async getTokenAllowance(owner, spender, token) {
      const path = mirrorPaths.tokenAllowance(owner, spender, token);
      const [first] = await getList(path, "allowances");
      return first === undefined ? 0n : integerAt(objectAt(first, path, "allowance"), "amount", path);
    },

    async getTransaction(consensusTimestamp) {
      const path = mirrorPaths.transaction(consensusTimestamp);
      const [record] = await getList(path, "transactions");
      return record === undefined ? null : parseTransaction(record, path);
    },

    async waitForResult(hash, options = {}) {
      const { timeoutMs, intervalMs } = { ...DEFAULT_WAIT, ...options };
      const giveUpAt = now() + timeoutMs;
      for (;;) {
        const result = await getContractResult(hash);
        if (result !== null) return result;
        if (now() + intervalMs > giveUpAt) {
          throw new MirrorError(
            "timeout",
            mirrorPaths.contractResult(hash),
            404,
            `The mirror node still has no result for ${hash} after ${timeoutMs / 1000} s.`,
          );
        }
        await sleep(intervalMs);
      }
    },
  };
}

/** The JSON body of a mirror answer, or null for anything else (a proxy's HTML error page): the status says enough. */
export async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** For Node scripts: straight to the mirror node, e.g. https://testnet.mirrornode.hedera.com. */
export function directMirrorTransport(baseUrl: string, fetchFn: typeof fetch = fetch): MirrorTransport {
  return async path => {
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, { signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS) });
    } catch (error: unknown) {
      throw new MirrorError("unavailable", path, null, "The mirror node did not answer.", error);
    }
    return { status: response.status, body: await readJsonBody(response) };
  };
}

/** For the browser: through the app's own relay, which answers 200 whatever the mirror said. Testnet only. */
export function sameOriginMirrorTransport(fetchFn: typeof fetch = fetch): MirrorTransport {
  return async path => {
    let response: Response;
    try {
      response = await fetchFn(`${MIRROR_RELAY_ROUTE}?network=testnet&path=${encodeURIComponent(path)}`);
    } catch (error: unknown) {
      throw new MirrorError("unavailable", path, null, "The app's mirror relay did not answer.", error);
    }
    if (!response.ok) {
      throw new MirrorError("unavailable", path, null, `The app's mirror relay answered HTTP ${response.status}.`);
    }
    const envelope = objectAt(await readJsonBody(response), path, "relay answer");
    if (envelope.ok === true && typeof envelope.status === "number") {
      return { status: envelope.status, body: envelope.body };
    }
    const error = objectAt(envelope.error, path, "relay error");
    const message = stringAt(error, "message", path);
    throw new MirrorError(error.code === "mirror_unavailable" ? "unavailable" : "refused", path, null, message);
  };
}
