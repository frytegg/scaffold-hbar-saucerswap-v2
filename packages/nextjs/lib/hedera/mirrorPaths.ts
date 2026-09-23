import type { EntityId } from "./addresses";
import type { EvmAddress } from "./evmAddress";
import type { Hex } from "viem";

type AccountRef = EntityId | EvmAddress;

/** The mirror node REST paths this library reads, and the only ones the app's same-origin relay forwards. */
export const mirrorPaths = {
  contractResult: (hash: Hex): string => `/api/v1/contracts/results/${hash}`,
  // A swap leaves about a dozen actions: one page of 100 holds the whole call tree.
  contractActions: (hash: Hex): string => `/api/v1/contracts/results/${hash}/actions?limit=100`,
  account: (account: AccountRef): string => `/api/v1/accounts/${account}?transactions=false`,
  tokenRelationship: (account: AccountRef, token: EntityId): string =>
    `/api/v1/accounts/${account}/tokens?token.id=${token}`,
  tokenAllowance: (owner: AccountRef, spender: EntityId, token: EntityId): string =>
    `/api/v1/accounts/${owner}/allowances/tokens?spender.id=${spender}&token.id=${token}`,
  /** The serials of one NFT collection an account holds. The HTS facade has no enumeration; this is the only list. */
  accountNfts: (account: AccountRef, token: EntityId, limit: number): string =>
    `/api/v1/accounts/${account}/nfts?token.id=${token}&limit=${limit}&order=asc`,
  /** One serial of a collection, whoever holds it: when it was minted, who has it, and whether it was burnt. */
  nft: (token: EntityId, serialNumber: bigint | string): string => `/api/v1/tokens/${token}/nfts/${serialNumber}`,
  /** The transaction record at a consensus timestamp: its HBAR transfer list, fees included. */
  transaction: (consensusTimestamp: string): string => `/api/v1/transactions?timestamp=${consensusTimestamp}`,
};

const HASH = "0x[0-9a-fA-F]{64}";
const ENTITY = "\\d+\\.\\d+\\.\\d+";
const ACCOUNT = `(?:${ENTITY}|0x[0-9a-fA-F]{40})`;
const TIMESTAMP = "\\d+\\.\\d{9}";
const RELAYED_PATHS = [
  `/api/v1/contracts/results/${HASH}`,
  `/api/v1/contracts/results/${HASH}/actions\\?limit=100`,
  `/api/v1/accounts/${ACCOUNT}\\?transactions=false`,
  `/api/v1/accounts/${ACCOUNT}/tokens\\?token\\.id=${ENTITY}`,
  `/api/v1/accounts/${ACCOUNT}/allowances/tokens\\?spender\\.id=${ENTITY}&token\\.id=${ENTITY}`,
  `/api/v1/accounts/${ACCOUNT}/nfts\\?token\\.id=${ENTITY}&limit=\\d{1,3}&order=asc`,
  `/api/v1/tokens/${ENTITY}/nfts/\\d+`,
  `/api/v1/transactions\\?timestamp=${TIMESTAMP}`,
].map(pattern => new RegExp(`^${pattern}$`));

export function isRelayedMirrorPath(path: string): boolean {
  return RELAYED_PATHS.some(pattern => pattern.test(path));
}

/** The same-origin route that forwards those GETs for the browser: app/api/hedera/mirror/route.ts. */
export const MIRROR_RELAY_ROUTE = "/api/hedera/mirror";

export type MirrorRelayErrorCode = "invalid_network" | "invalid_path" | "misconfigured" | "mirror_unavailable";

/**
 * The relay's answer, always sent with HTTP 200: a browser logs every 4xx or 5xx response as a console error, and the
 * mirror answers 404 until a transaction is ingested. `status` is the mirror node's own HTTP status.
 */
export type MirrorRelayResponse =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: { code: MirrorRelayErrorCode; message: string } };
