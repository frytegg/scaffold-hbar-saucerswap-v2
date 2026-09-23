import type { PublicClient } from "viem";
import { MIRROR_UNAVAILABLE, headlineFor } from "~~/components/hedera/failureText";
import {
  type EvmAddress,
  type HbarPoolEntry,
  type HederaFailure,
  type MirrorClient,
  type PoolState,
  type PositionFields,
  type PositionStatus,
  explainError,
  orderPoolTokens,
  positionStatus,
  readPoolState,
  readPosition,
  readPositionSerials,
} from "~~/lib/hedera";

// Reading an account's liquidity positions takes three sources and no signature. Which serials it holds is on the
// mirror node alone: the position is an HTS NFT and the facade of that collection has no enumeration. What is
// inside a serial comes from the position manager, whose `positions` answers ten fields. What the position is worth
// now, and therefore what closing it would return, needs the pool's own live price.
// The reads are an argument, so every refusal below has a test that needs no network.

export type PositionsReads = {
  serials(account: EvmAddress): Promise<{ serials: bigint[]; hasMore: boolean }>;
  pool(): Promise<PoolState>;
  position(serial: bigint): Promise<PositionFields | null>;
};

/** The reads as the browser makes them: the mirror node and JSON-RPC, both through this app's own origin. */
export function createPositionsReads(client: PublicClient, mirror: MirrorClient, pool: HbarPoolEntry): PositionsReads {
  return {
    serials: account => readPositionSerials(mirror, account),
    pool: () => readPoolState(client, pool),
    position: serial => readPosition(client, serial),
  };
}

export type PositionEntry =
  /** Read and priced against the live pool. */
  | { readonly serial: bigint; readonly state: "open"; readonly status: PositionStatus }
  /** Read, but nothing says what it is worth today: another pool, or a pool that did not answer. */
  | { readonly serial: bigint; readonly state: "unpriced"; readonly position: PositionFields; readonly reason: string }
  /** The manager does not know the serial any more: it was burnt between the two reads. */
  | { readonly serial: bigint; readonly state: "closed" }
  | { readonly serial: bigint; readonly state: "unreadable"; readonly failure: HederaFailure };

export type PositionsResult =
  | {
      readonly ok: true;
      readonly entries: readonly PositionEntry[];
      /** The mirror node serves one page; more serials than that are not listed here, and the page says so. */
      readonly hasMore: boolean;
      readonly pool: PoolState | null;
      /** Why the pool did not answer, when it did not: every entry is then unpriced for that reason. */
      readonly poolFailure: HederaFailure | null;
      readonly readAt: number;
    }
  | { readonly ok: false; readonly headline: string; readonly failure: HederaFailure };

/**
 * Whether a position was opened in the pool this template knows. The manager answers the two token addresses and
 * the fee of the pool the position belongs to, which is the only way to tell: a serial carries no pool address.
 */
export function isPositionOfPool(position: PositionFields, pool: HbarPoolEntry): boolean {
  const { token0, token1 } = orderPoolTokens(pool);
  const same = (left: EvmAddress, right: EvmAddress): boolean => left.toLowerCase() === right.toLowerCase();
  return (
    same(position.token0, token0.evmAddress) && same(position.token1, token1.evmAddress) && position.fee === pool.fee
  );
}

/**
 * How many positions are read at a time. Each one is a JSON-RPC call, and hashio's own rate limit is not published:
 * a page of a hundred serials sent at once is a burst this template has never measured, and a refused read would
 * read as a missing position.
 */
const POSITIONS_READ_AT_ONCE = 5;

async function readEntry(reads: PositionsReads, serial: bigint, priceAgainst: PricingContext): Promise<PositionEntry> {
  let position: PositionFields | null;
  try {
    position = await reads.position(serial);
  } catch (error: unknown) {
    return { serial, state: "unreadable", failure: explainError(error) };
  }
  if (position === null) return { serial, state: "closed" };
  if (!isPositionOfPool(position, priceAgainst.pool)) {
    return {
      serial,
      state: "unpriced",
      position,
      reason:
        `This position is in another pool: token0 ${position.token0}, token1 ${position.token1}, fee ` +
        `${position.fee}. The address book of this template holds one pool, so its live price is not read here.`,
    };
  }
  if (priceAgainst.state === null) {
    return {
      serial,
      state: "unpriced",
      position,
      reason: `The pool's live price could not be read, so what closing it returns is unknown. ${priceAgainst.why}`,
    };
  }
  return { serial, state: "open", status: positionStatus(position, priceAgainst.state) };
}

type PricingContext = { readonly pool: HbarPoolEntry; readonly state: PoolState | null; readonly why: string };

export async function readPositions(input: {
  readonly reads: PositionsReads;
  readonly account: EvmAddress;
  readonly pool: HbarPoolEntry;
  readonly now: number;
}): Promise<PositionsResult> {
  const { reads, account, pool, now } = input;
  // The two sources are independent, and only the list is fatal: without the pool's price the serials are still
  // worth showing, which is what the unpriced state is for.
  const [listed, priced] = await Promise.allSettled([reads.serials(account), reads.pool()]);

  if (listed.status === "rejected") {
    const failure = explainError(listed.reason);
    return {
      ok: false,
      headline: headlineFor(failure, {
        refused: "Your positions could not be listed",
        unavailable: MIRROR_UNAVAILABLE,
      }),
      failure,
    };
  }

  const poolFailure = priced.status === "rejected" ? explainError(priced.reason) : null;
  const priceAgainst: PricingContext = {
    pool,
    state: priced.status === "fulfilled" ? priced.value : null,
    why: poolFailure === null ? "" : poolFailure.message,
  };

  const entries: PositionEntry[] = [];
  for (let start = 0; start < listed.value.serials.length; start += POSITIONS_READ_AT_ONCE) {
    const batch = listed.value.serials.slice(start, start + POSITIONS_READ_AT_ONCE);
    entries.push(...(await Promise.all(batch.map(serial => readEntry(reads, serial, priceAgainst)))));
  }

  return {
    ok: true,
    entries,
    hasMore: listed.value.hasMore,
    pool: priceAgainst.state,
    poolFailure,
    readAt: now,
  };
}
