import type { Hex } from "viem";
import { type EntityId, mirrorPaths } from "~~/lib/hedera";

// Where a reader checks what a page of this template says. The mirror node answers JSON and is machine-checkable,
// which is why every figure in this project is read back from it; Hashscan renders the same entity for a person and
// answers 404 to anything but a browser. So both are always offered, and never one alone.
//
// These are links for a reader, not reads: the paths this app's own relay forwards are in lib/hedera/mirrorPaths.ts,
// and a serial's own record is not among them.

const MIRROR_TESTNET = "https://testnet.mirrornode.hedera.com";
const HASHSCAN_TESTNET = "https://hashscan.io/testnet";

/** The mirror node's DETAIL view of a transaction: machine-readable, and what every check of this project reads. */
export function mirrorResultUrl(hash: Hex): string {
  return `${MIRROR_TESTNET}${mirrorPaths.contractResult(hash)}`;
}

/** Hashscan renders the same transaction for a person; its deep links answer 404 to anything but a browser. */
export function hashscanTransactionUrl(hash: Hex): string {
  return `${HASHSCAN_TESTNET}/tx/${hash}`;
}

/** One serial of an HTS collection, with the field that says whether it was burnt. */
export function mirrorNftUrl(token: EntityId, serial: bigint): string {
  return `${MIRROR_TESTNET}/api/v1/tokens/${token}/nfts/${serial}`;
}

export function hashscanNftUrl(token: EntityId, serial: bigint): string {
  return `${HASHSCAN_TESTNET}/token/${token}/${serial}`;
}

/** A contract or a token, by its Hedera entity id rather than its EVM address. */
export function hashscanContractUrl(entity: EntityId): string {
  return `${HASHSCAN_TESTNET}/contract/${entity}`;
}
