"use client";

import { type AccountState, associationSummary } from "./accountState";
import { FailureNote, Row } from "~~/components/hedera/atoms";
import { MIRROR_UNAVAILABLE, headlineFor } from "~~/components/hedera/failureText";
import { type HederaFailure, type TokenEntry, formatHbar, formatTokenAmount, testnet } from "~~/lib/hedera";

// What the network says about the connected account, all of it read through this app's own origin. Every line is
// something a swap depends on: the balance it spends, the allowance the router needs, and whether the token can
// arrive at all.

function slotsLine(slots: number): string {
  if (slots === -1) return "unlimited";
  if (slots === 0) return "none";
  return `${slots}; the mirror node does not say how many are free`;
}

export const AccountCard = ({
  state,
  failure,
  busy,
  token,
  onRefresh,
}: {
  state: AccountState | null;
  failure: HederaFailure | null;
  busy: boolean;
  token: TokenEntry;
  onRefresh: () => void;
}) => (
  <section className="card bg-base-100 shadow p-5 flex flex-col gap-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-xl font-semibold m-0">Your account on Hedera testnet</h2>
      <button className="btn btn-sm" disabled={busy} onClick={onRefresh}>
        {busy ? "Reading…" : "Refresh"}
      </button>
    </div>
    {failure !== null && (
      <FailureNote
        headline={headlineFor(failure, {
          refused: "Your account could not be read",
          unavailable: MIRROR_UNAVAILABLE,
        })}
        failure={failure}
      />
    )}
    {state === null ? (
      <p className="m-0 text-sm">{busy ? "Reading the account from the mirror node…" : "Nothing read yet."}</p>
    ) : state.account === null ? (
      <p className="m-0 text-sm">
        No Hedera account exists at {state.address} yet. Send it HBAR, from the Hedera Portal faucet for instance: the
        first transfer creates the account.
      </p>
    ) : (
      <>
        <Row label="Hedera account" value={`${state.account.accountId} (${state.account.evmAddress})`} />
        <Row label="HBAR" value={formatHbar(state.account.balance)} />
        <Row label={token.symbol} value={formatTokenAmount(state.relationship?.balance ?? 0n, token)} />
        <Row
          label={`Allowance to the SaucerSwap router ${testnet.swapRouter.id}`}
          value={formatTokenAmount(state.routerAllowance ?? 0n, token)}
        />
        <Row label="Automatic association slots" value={slotsLine(state.account.maxAutomaticTokenAssociations)} />
        <p className="m-0 text-sm">{associationSummary(state, token)}</p>
      </>
    )}
  </section>
);
