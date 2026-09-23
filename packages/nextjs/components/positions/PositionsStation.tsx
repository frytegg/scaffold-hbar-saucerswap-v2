"use client";

import { useCallback, useMemo, useState } from "react";
import { PoolCard } from "./PoolCard";
import { PositionCard } from "./PositionCard";
import { EMPTY_LIST, MORE_THAN_ONE_PAGE, READ_ONLY_NOTE } from "./positionsPresentation";
import { type PositionsResult, createPositionsReads, readPositions } from "./positionsRead";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, usePublicClient } from "wagmi";
import { FailureNote } from "~~/components/hedera/atoms";
import { MIRROR_UNAVAILABLE, headlineFor } from "~~/components/hedera/failureText";
import {
  type HederaFailure,
  createMirrorClient,
  explainError,
  isEvmAddress,
  sameOriginMirrorTransport,
  testnet,
  toEvmAddress,
} from "~~/lib/hedera";

// The liquidity positions an account holds, read and nothing else. It reads on request, never on load: every
// request this page makes goes to its own origin, and none of them is made before the button below is pressed.
// Which chain the wallet is on does not matter here, because nothing is signed: the addresses read are Hedera
// testnet's, from the address book, whatever network the wallet happens to be showing.

const POOL = testnet.hbarSaucePool;

export const PositionsStation = () => {
  const { address, status } = useAccount();
  const client = usePublicClient({ chainId: testnet.chainId });
  const { openConnectModal } = useConnectModal();

  const mirror = useMemo(() => createMirrorClient({ transport: sameOriginMirrorTransport() }), []);
  const account = useMemo(
    () => (address !== undefined && isEvmAddress(address) ? toEvmAddress(address) : null),
    [address],
  );

  const [result, setResult] = useState<PositionsResult | null>(null);
  const [failure, setFailure] = useState<HederaFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async (): Promise<void> => {
    if (client === undefined || account === null) return;
    setBusy(true);
    setFailure(null);
    try {
      setResult(
        await readPositions({
          reads: createPositionsReads(client, mirror, POOL),
          account,
          pool: POOL,
          now: Date.now(),
        }),
      );
    } catch (error: unknown) {
      setResult(null);
      setFailure(explainError(error));
    } finally {
      setBusy(false);
    }
  }, [client, account, mirror]);

  const ready = status === "connected" && account !== null && client !== undefined;

  return (
    <div className="flex flex-col gap-6 w-full max-w-4xl mx-auto px-5 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold m-0">Your SaucerSwap V2 positions</h1>
        <p className="m-0">
          A liquidity position on SaucerSwap V2 is an HTS NFT, and the facade of that collection cannot be asked what an
          account holds: the serials come from the mirror node, and what is inside each one from the position manager,
          whose <code>positions</code> answers ten fields where the Uniswap function of the same name answers twelve.
          Both reads are here, next to the pool&apos;s live price, which is what says whether a range is earning
          anything.
        </p>
        <p className="m-0 text-sm">{READ_ONLY_NOTE}</p>
      </header>

      <section className="card bg-base-100 shadow p-5 flex flex-col gap-2">
        <h2 className="text-xl font-semibold m-0">Wallet</h2>
        {status === "connecting" || status === "reconnecting" ? (
          <p className="m-0 text-sm">Connecting…</p>
        ) : status !== "connected" ? (
          <>
            <p className="m-0 text-sm">
              Connect a wallet to read the positions of its address. Nothing is read before you do, and nothing here is
              ever signed.
            </p>
            {openConnectModal !== undefined && (
              <button className="btn btn-primary btn-sm w-fit" onClick={openConnectModal}>
                Connect a wallet
              </button>
            )}
          </>
        ) : account === null ? (
          <p className="m-0 text-sm">This wallet gave an address that is not a 20-byte EVM address.</p>
        ) : (
          <>
            <p className="m-0 text-sm font-mono break-all">{account}</p>
            <button className="btn btn-primary btn-sm w-fit" disabled={busy} onClick={() => void read()}>
              {busy ? "Reading…" : result === null ? "Read my positions" : "Read them again"}
            </button>
          </>
        )}
      </section>

      {failure !== null && (
        <FailureNote
          headline={headlineFor(failure, {
            refused: "Your positions could not be read",
            unavailable: MIRROR_UNAVAILABLE,
          })}
          failure={failure}
        />
      )}

      {result !== null && !result.ok && <FailureNote headline={result.headline} failure={result.failure} />}

      {result !== null && result.ok && (
        <>
          <PoolCard pool={POOL} state={result.pool} failure={result.poolFailure} />
          {result.entries.length === 0 ? (
            <p className="m-0 text-sm">{EMPTY_LIST}</p>
          ) : (
            result.entries.map(entry => <PositionCard key={entry.serial.toString()} entry={entry} pool={POOL} />)
          )}
          {result.hasMore && <p className="m-0 text-sm">{MORE_THAN_ONE_PAGE}</p>}
        </>
      )}

      {ready && result === null && failure === null && !busy && <p className="m-0 text-sm">Nothing read yet.</p>}

      <p className="m-0 text-sm opacity-70">
        Hedera testnet only, through the addresses in <code>packages/nextjs/lib/hedera/addresses.ts</code>. The serials
        come through <code>/api/hedera/mirror</code> and the manager and pool through <code>/api/hedera/rpc</code>, both
        of them this app&apos;s own origin.
      </p>
    </div>
  );
};
