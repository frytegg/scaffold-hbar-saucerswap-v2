"use client";

import { type AmountPair, amountPair, groupDigits, rangeLine, tickRangeLine } from "./positionsPresentation";
import type { PositionEntry } from "./positionsRead";
import { FailureNote, Row } from "~~/components/hedera/atoms";
import { MIRROR_UNAVAILABLE, headlineFor } from "~~/components/hedera/failureText";
import { hashscanNftUrl, mirrorNftUrl } from "~~/components/hedera/links";
import { type HbarPoolEntry, type PositionFields, type PositionStatus, testnet } from "~~/lib/hedera";

// One serial of the position collection. Four states reach this card and every one of them renders: priced against
// the live pool, read but not priceable, gone from the manager, and a read that got no answer.

const both = (pair: AmountPair): string => `${pair.hbar} and ${pair.token}`;

const SerialLinks = ({ serial }: { serial: bigint }) => (
  <div className="flex flex-wrap gap-4 text-sm">
    <a className="link" href={mirrorNftUrl(testnet.lpNft.id, serial)} target="_blank" rel="noreferrer">
      Mirror node (this serial)
    </a>
    <a className="link" href={hashscanNftUrl(testnet.lpNft.id, serial)} target="_blank" rel="noreferrer">
      Hashscan
    </a>
  </div>
);

const PricedPosition = ({ status, pool }: { status: PositionStatus; pool: HbarPoolEntry }) => (
  <>
    <p className="m-0 text-sm">{rangeLine(status.range, pool).sentence}</p>
    <Row label="Range, in ticks" value={tickRangeLine(status.position)} />
    <Row label="Liquidity" value={groupDigits(status.position.liquidity)} />
    <Row label="In the pool at today's price" value={both(amountPair(status.principal, pool))} />
    <Row label="Already owed, waiting in the manager" value={both(amountPair(status.owed, pool))} />
    <Row label="A close would return" value={both(amountPair(status.closeReturns, pool))} />
  </>
);

const UnpricedPosition = ({ position, reason }: { position: PositionFields; reason: string }) => (
  <>
    <p className="m-0 text-sm">{reason}</p>
    <Row label="Range, in ticks" value={tickRangeLine(position)} />
    <Row label="Liquidity" value={groupDigits(position.liquidity)} />
    <Row
      label="Owed, in each token's own smallest unit"
      value={`${groupDigits(position.tokensOwed0)} and ${groupDigits(position.tokensOwed1)}`}
    />
  </>
);

export const PositionCard = ({ entry, pool }: { entry: PositionEntry; pool: HbarPoolEntry }) => (
  <section className="card bg-base-100 shadow p-5 flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-lg font-semibold m-0">Serial {entry.serial.toString()}</h3>
      {entry.state === "open" && (
        <span className="badge badge-neutral">{rangeLine(entry.status.range, pool).label}</span>
      )}
      {entry.state === "closed" && <span className="badge badge-ghost">closed</span>}
    </div>
    <SerialLinks serial={entry.serial} />

    {entry.state === "open" && <PricedPosition status={entry.status} pool={pool} />}
    {entry.state === "unpriced" && <UnpricedPosition position={entry.position} reason={entry.reason} />}

    {entry.state === "closed" && (
      <p className="m-0 text-sm">
        The mirror node listed this serial and the position manager no longer knows it: it was burnt between the two
        reads. The serial&apos;s own record says so.
      </p>
    )}

    {entry.state === "unreadable" && (
      <FailureNote
        headline={headlineFor(entry.failure, {
          refused: "This serial could not be read",
          unavailable: MIRROR_UNAVAILABLE,
        })}
        failure={entry.failure}
      />
    )}
  </section>
);
