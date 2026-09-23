"use client";

import { feeTierLabel, groupDigits, poolTickLine } from "./positionsPresentation";
import { FailureNote, Row } from "~~/components/hedera/atoms";
import { SAUCERSWAP_UNAVAILABLE, headlineFor } from "~~/components/hedera/failureText";
import { hashscanContractUrl } from "~~/components/hedera/links";
import { type HbarPoolEntry, type HederaFailure, type PoolState, testnet } from "~~/lib/hedera";

// The pool a position of this template is opened in. Its live tick is what decides whether a range is earning, so
// it is shown next to the positions rather than hidden inside their arithmetic.

export const PoolCard = ({
  pool,
  state,
  failure,
}: {
  pool: HbarPoolEntry;
  state: PoolState | null;
  /** Why the pool did not answer, when it did not: the positions below are then listed without a price. */
  failure: HederaFailure | null;
}) => (
  <section className="card bg-base-100 shadow p-5 flex flex-col gap-2">
    <h2 className="text-xl font-semibold m-0">
      The pool: HBAR and {pool.token.symbol}, {feeTierLabel(pool.fee)}
    </h2>
    {failure !== null && (
      <FailureNote
        headline={headlineFor(failure, { refused: "The pool did not answer", unavailable: SAUCERSWAP_UNAVAILABLE })}
        failure={failure}
      />
    )}
    <Row label="Pool" value={`${pool.id} (${pool.evmAddress})`} />
    <Row label="Position manager" value={`${testnet.positionManager.id} (${testnet.positionManager.evmAddress})`} />
    <Row label="Position collection" value={`${testnet.lpNft.id}, symbol ${testnet.lpNft.symbol}`} />
    {state !== null && (
      <>
        <Row label="Tick now" value={poolTickLine(state)} />
        <Row label="Liquidity at that tick" value={groupDigits(state.liquidity)} />
      </>
    )}
    <div className="flex flex-wrap gap-4 text-sm">
      <a className="link" href={hashscanContractUrl(pool.id)} target="_blank" rel="noreferrer">
        The pool on Hashscan
      </a>
      <a className="link" href={hashscanContractUrl(testnet.positionManager.id)} target="_blank" rel="noreferrer">
        The position manager on Hashscan
      </a>
    </div>
  </section>
);
