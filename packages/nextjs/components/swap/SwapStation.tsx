"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AccountCard } from "./AccountCard";
import { OutcomeCard } from "./OutcomeCard";
import { PreflightPanel } from "./PreflightPanel";
import { SwapForm } from "./SwapForm";
import { type AccountState, readAccountState } from "./accountState";
import { FailureNote } from "./atoms";
import { type Refusal, type SwapPlan, buildSwapPlan, createPlanReads } from "./swapPlan";
import {
  type PanelCheck,
  SAUCERSWAP_UNAVAILABLE,
  type SwapDirection,
  checkOf,
  checkOfRefusal,
  facadeReturnVerdict,
  headlineFor,
  quoteFreshness,
  sendIsBlocked,
  unitsOf,
} from "./swapPresentation";
import { type TransactionOutcome, succeeded, trackTransaction } from "./transactionOutcome";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useConfig, usePublicClient, useSwitchChain } from "wagmi";
import { writeContract } from "wagmi/actions";
import {
  type HederaFailure,
  buildApproveCall,
  createMirrorClient,
  explainError,
  formatTokenAmount,
  isEvmAddress,
  sameOriginMirrorTransport,
  testnet,
  toEvmAddress,
} from "~~/lib/hedera";

// One route for a SaucerSwap V2 swap, both ways. What it is for: everything the network checks below the EVM is
// checked here first, from the browser, before a wallet is ever asked to sign — because on Hedera a simulator can
// accept a swap the network then rejects, and the wallet shows no warning and takes the gas anyway.

const POOL = testnet.hbarSaucePool;
const TOKEN = POOL.token;
/** The router refuses the swap after this, which is long enough for a wallet confirmation and short enough to matter. */
const DEADLINE_SECONDS = 1_200;

export const SwapStation = () => {
  const config = useConfig();
  const { address, chainId, connector, status } = useAccount();
  const client = usePublicClient({ chainId: testnet.chainId });
  const { switchChainAsync } = useSwitchChain();
  const { openConnectModal } = useConnectModal();

  const mirror = useMemo(() => createMirrorClient({ transport: sameOriginMirrorTransport() }), []);
  const account = useMemo(
    () => (address !== undefined && isEvmAddress(address) ? toEvmAddress(address) : null),
    [address],
  );

  const [direction, setDirection] = useState<SwapDirection>("hbar-to-token");
  const [amount, setAmount] = useState("0.1");
  const [slippage, setSlippage] = useState("0.5");

  const [accountState, setAccountState] = useState<AccountState | null>(null);
  const [accountFailure, setAccountFailure] = useState<HederaFailure | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [plan, setPlan] = useState<SwapPlan | null>(null);
  const [planRefusal, setPlanRefusal] = useState<Refusal | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [now, setNow] = useState(0);

  const [facadeCheck, setFacadeCheck] = useState<PanelCheck | null>(null);
  const [approveOutcome, setApproveOutcome] = useState<TransactionOutcome | null>(null);
  const [approveFailure, setApproveFailure] = useState<HederaFailure | null>(null);
  const [approving, setApproving] = useState(false);

  const [outcome, setOutcome] = useState<TransactionOutcome | null>(null);
  const [sendFailure, setSendFailure] = useState<HederaFailure | null>(null);
  const [sending, setSending] = useState(false);

  const [switchFailure, setSwitchFailure] = useState<HederaFailure | null>(null);

  const browserWallet = connector?.type === "injected";
  const onTestnet = chainId === testnet.chainId;
  const ready = status === "connected" && browserWallet && onTestnet && account !== null && client !== undefined;
  const accountId = accountState?.account?.accountId ?? null;

  // The panel's lines and the age of the quote, computed here because the send handler decides on them too. The
  // lines are memoised: the handler depends on them, and a new array every render would rebuild it every second.
  const checks = useMemo(
    () => (plan === null ? [] : facadeCheck === null ? plan.checks : [facadeCheck, ...plan.checks]),
    [plan, facadeCheck],
  );
  const freshness = plan === null ? null : quoteFreshness(plan.quotedAt, Math.max(now, plan.quotedAt));

  useEffect(() => {
    if (!ready || client === undefined || account === null) {
      setAccountState(null);
      setAccountFailure(null);
      return;
    }
    let live = true;
    setAccountBusy(true);
    readAccountState(client, mirror, account, TOKEN)
      .then(state => {
        if (!live) return;
        setAccountState(state);
        setAccountFailure(null);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setAccountState(null);
        setAccountFailure(explainError(error));
      })
      .finally(() => {
        if (live) setAccountBusy(false);
      });
    return () => {
      live = false;
    };
  }, [ready, client, mirror, account, refreshKey]);

  useEffect(() => {
    if (plan === null) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [plan]);

  const runQuote = useCallback(async (): Promise<void> => {
    if (client === undefined || account === null) return;
    setQuoting(true);
    setPlan(null);
    setPlanRefusal(null);
    setFacadeCheck(null);
    setOutcome(null);
    setSendFailure(null);
    try {
      const result = await buildSwapPlan({
        reads: createPlanReads(client, mirror),
        account,
        pool: POOL,
        direction,
        amountInput: amount,
        slippageInput: slippage,
        deadlineSeconds: DEADLINE_SECONDS,
        now: Date.now(),
      });
      setNow(Date.now());
      if (result.ok) setPlan(result.plan);
      else setPlanRefusal({ check: result.check, headline: result.headline });
    } catch (error: unknown) {
      const failure = explainError(error);
      setPlanRefusal({
        check: checkOfRefusal("quote", "Quote", failure),
        headline: headlineFor(failure, { refused: "The quote failed", unavailable: SAUCERSWAP_UNAVAILABLE }),
      });
    } finally {
      setQuoting(false);
    }
  }, [client, account, mirror, direction, amount, slippage]);

  const onApprove = useCallback(async (): Promise<void> => {
    if (plan === null || plan.approveAmount === null) return;
    setApproving(true);
    setApproveFailure(null);
    setApproveOutcome(null);
    setFacadeCheck(null);
    try {
      const call = buildApproveCall(TOKEN, plan.approveAmount);
      const hash = await writeContract(config, { ...call, chainId: testnet.chainId });
      const result = await trackTransaction(mirror, hash, accountId);
      setApproveOutcome(result);
      setRefreshKey(key => key + 1);
      if (!succeeded(result)) return;
      const verdict = facadeReturnVerdict(result.result?.callResult ?? null);
      setFacadeCheck(checkOf("facade", "What the token facade returned", verdict));
      if (verdict.status === "pass") await runQuote();
    } catch (error: unknown) {
      setApproveFailure(explainError(error));
    } finally {
      setApproving(false);
    }
  }, [plan, config, mirror, accountId, runQuote]);

  const onSend = useCallback(async (): Promise<void> => {
    // The button is disabled on the same answer. Asking it again here is what keeps a blocked check or a quote
    // nobody has looked at since from reaching a wallet through any other path into this handler.
    if (plan === null || freshness === null || sendIsBlocked({ checks, freshness, sendBusy: sending })) return;
    setSending(true);
    setSendFailure(null);
    setOutcome(null);
    try {
      const hash = await writeContract(config, { ...plan.call, chainId: testnet.chainId });
      setOutcome(await trackTransaction(mirror, hash, accountId));
      setRefreshKey(key => key + 1);
    } catch (error: unknown) {
      setSendFailure(explainError(error, { address: plan.call.address, functions: plan.functions }));
    } finally {
      setSending(false);
    }
  }, [plan, checks, freshness, sending, config, mirror, accountId]);

  const onSwitch = useCallback(async (): Promise<void> => {
    setSwitchFailure(null);
    try {
      await switchChainAsync({ chainId: testnet.chainId });
    } catch (error: unknown) {
      setSwitchFailure(explainError(error));
    }
  }, [switchChainAsync]);

  const approveAmount = plan?.approveAmount ?? null;
  const approveAction =
    approveAmount === null
      ? null
      : {
          label: `Approve ${formatTokenAmount(approveAmount, TOKEN)} for the router`,
          busy: approving,
          onClick: () => void onApprove(),
        };

  return (
    <div className="flex flex-col gap-6 w-full max-w-4xl mx-auto px-5 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold m-0">Swap on SaucerSwap V2</h1>
        <p className="m-0">
          HBAR to {TOKEN.symbol} and back, on Hedera testnet. Before your wallet opens, this page reads what the network
          checks below the EVM — the router&apos;s allowance, whether the token can reach your account — and refuses the
          swap itself when one of them would fail. One of the two is a simulator&apos;s blind spot:{" "}
          <code>eth_call</code>, <code>eth_estimateGas</code> and the mirror node all accepted a swap the router had no
          allowance for, the network rejected it, and the gas was gone. A token that cannot reach the recipient reverts
          on the network, and that is charged too. Those transactions, with their dates, are in{" "}
          <code>docs/hedera-behaviour.md</code>.
        </p>
      </header>

      <section className="card bg-base-100 shadow p-5 flex flex-col gap-2">
        <h2 className="text-xl font-semibold m-0">Wallet</h2>
        {status === "connecting" || status === "reconnecting" ? (
          <p className="m-0 text-sm">Connecting…</p>
        ) : status !== "connected" ? (
          <>
            <p className="m-0 text-sm">
              Connect a browser wallet on Hedera testnet (chain {testnet.chainId}). Nothing is read before you do.
            </p>
            {openConnectModal !== undefined && (
              <button className="btn btn-primary btn-sm w-fit" onClick={openConnectModal}>
                Connect a wallet
              </button>
            )}
          </>
        ) : !browserWallet ? (
          <div className="alert alert-warning text-sm">
            Connected with {connector?.name ?? "a wallet"}, which is not a browser wallet. This route reads and sends
            through a browser wallet only: the burner wallet&apos;s key lives in this browser, and every transaction
            here is a real one on a live network. Open the address menu at the top right, disconnect, then connect your
            browser wallet.
          </div>
        ) : !onTestnet ? (
          <>
            <p className="m-0 text-sm">
              This route is Hedera testnet, chain {testnet.chainId}; your wallet is on chain {chainId ?? "unknown"}. The
              addresses this page calls exist there and nowhere else.
            </p>
            <button className="btn btn-primary btn-sm w-fit" onClick={() => void onSwitch()}>
              Switch to Hedera testnet (your wallet adds it if it is missing)
            </button>
            {switchFailure !== null && (
              <FailureNote headline="The wallet did not switch network" failure={switchFailure} />
            )}
          </>
        ) : account === null ? (
          <p className="m-0 text-sm">This wallet gave an address that is not a 20-byte EVM address.</p>
        ) : (
          <p className="m-0 text-sm">Connected with {connector?.name ?? "a browser wallet"} on Hedera testnet.</p>
        )}
      </section>

      {ready && (
        <>
          <AccountCard
            state={accountState}
            failure={accountFailure}
            busy={accountBusy}
            token={TOKEN}
            onRefresh={() => setRefreshKey(key => key + 1)}
          />

          <SwapForm
            token={TOKEN}
            direction={direction}
            amount={amount}
            slippage={slippage}
            busy={quoting}
            onDirection={next => {
              setDirection(next);
              setPlan(null);
              setPlanRefusal(null);
            }}
            onAmount={setAmount}
            onSlippage={setSlippage}
            onQuote={() => void runQuote()}
          />

          {planRefusal !== null && (
            <section className="card bg-base-100 shadow p-5 flex flex-col gap-2">
              <h2 className="text-xl font-semibold m-0">{planRefusal.headline}</h2>
              <p className="m-0 text-sm opacity-70">{planRefusal.check.label}</p>
              <p className="m-0">{planRefusal.check.message}</p>
              {planRefusal.check.actionLabel !== null && (
                <p className="m-0 text-sm font-medium">What to do: {planRefusal.check.actionLabel}</p>
              )}
              <p className="m-0 text-sm">Nothing was sent, and nothing was signed.</p>
            </section>
          )}

          {plan !== null && freshness !== null && (
            <PreflightPanel
              plan={plan}
              token={TOKEN}
              checks={checks}
              freshness={freshness}
              approveAction={approveAction}
              sendBusy={sending}
              onSend={() => void onSend()}
            />
          )}

          <OutcomeCard
            title="The approval"
            outcome={approveOutcome}
            pending={approving && approveOutcome === null}
            sendFailure={approveFailure}
            outputUnit={null}
          />

          <OutcomeCard
            title="The swap"
            outcome={outcome}
            pending={sending && outcome === null}
            sendFailure={sendFailure}
            outputUnit={plan === null ? null : unitsOf(plan.direction, TOKEN).output}
          />
        </>
      )}

      <p className="m-0 text-sm opacity-70">
        Hedera testnet only, through the addresses in <code>packages/nextjs/lib/hedera/addresses.ts</code>. Every
        request this page makes goes to its own origin, <code>/api/hedera/rpc</code> for JSON-RPC and{" "}
        <code>/api/hedera/mirror</code> for the mirror node, and none of them is made before you ask for a quote.
      </p>
    </div>
  );
};
