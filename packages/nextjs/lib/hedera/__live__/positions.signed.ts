import { testnet } from "../addresses";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceAccountState,
  type EvidencePosition,
  type EvidencePreflight,
  type EvidenceRole,
  type EvidenceTransaction,
  type PositionEvidenceRecord,
  checkPositionEvidence,
  evidenceFileName,
  evidenceTransaction,
} from "../evidence";
import { type EvmAddress, toEvmAddress } from "../evmAddress";
import { type FailureContext, explainError, postMortem } from "../failure";
import { amountsForLiquidity } from "../liquidityMath";
import type { MirrorAccount, MirrorContractResult, MirrorTransaction } from "../mirror";
import {
  buildBurn,
  buildDecreaseLiquidity,
  buildManagerTokenApproval,
  buildNftApproval,
  buildPositionMint,
  buildSplitCollect,
  mintValue,
  positionMintGasLimit,
} from "../position";
import { checkPositionBurn, checkPositionMint } from "../positionPreflight";
import {
  readManagerAllowance,
  readMintFeeTinybar,
  readNftApproval,
  readPoolState,
  readPosition,
  readPositionSerials,
} from "../positionReads";
import { type PreflightVerdict, checkCost } from "../preflight";
import { type BuiltCall, swapDeadline } from "../swap";
import { narrowRangeAround } from "../tickMath";
import { type Tinybar, formatHbar, formatTokenAmount, hbarToTinybar, tinybar, toTinybar, toWeibar } from "../units";
import {
  assertBurnt,
  assertEmptied,
  assertPreflightPasses,
  hbarPaidByCollect,
  minimumsUnder,
  newSerial,
  offered,
  openedPosition,
  planDeposit,
  poolSides,
} from "./positionRun";
import { assertApprovalGranted, assertTestnet, assertWithinCeiling, privateKeyOf, signingAccount } from "./runGuards";
import { EVIDENCE_DIR, mirrorBaseUrl, testnetClient, testnetMirror } from "./testnet";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Transport, type WalletClient, createWalletClient, http } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import viemPackage from "viem/package.json";
import { beforeAll, describe, expect, it } from "vitest";
import { jsonRpcUrl } from "~~/services/hedera/upstreams";

// Tier 4: one whole life cycle of a SaucerSwap V2 liquidity position, signed and sent on Hedera testnet through this
// library — the approvals the account is missing, the mint no simulator will price, the read-back, the decrease, the
// split collect that pays native HBAR and the burn — written to docs/evidence/ once the mirror node confirms every
// one of them. The key comes from the environment of this one command, never from a file.

const KEY = process.env.__RUNTIME_DEPLOYER_PRIVATE_KEY;
/** The run refuses a send that could take its spending above this. A cycle on a fresh account cost 4.3 HBAR. */
const RUN_CEILING = hbarToTinybar("6");
/** How much HBAR the position deposits, and what the run refuses to go over on either side. */
const HBAR_TARGET = hbarToTinybar("0.1");
const HBAR_BUDGET = hbarToTinybar("0.2");
const TOKEN_BUDGET = 15_000_000n;
/** The call offers this much above what the range needs, and refuses this much under it. */
const MARGIN_BPS = 1_000;
const TOLERANCE_BPS = 1_000;
const DEADLINE_SECONDS = 300;
/** The inner calls of the mint's multicall: what `gasRules.ts` recognises, and what no simulator prices. */
const MINT_FUNCTIONS = ["mint", "refundETH"] as const;

const pool = testnet.hbarSaucePool;
const sauce = testnet.sauce;
const { toPair, fromPair } = poolSides(pool);

function report(verdict: PreflightVerdict, into: EvidencePreflight[]): PreflightVerdict {
  console.info(`pre-flight ${verdict.check}: ${verdict.status}. ${verdict.message}`);
  into.push({ check: verdict.check, status: verdict.status, message: verdict.message });
  return verdict;
}

const title = KEY
  ? "a signed position life cycle on Hedera testnet, written to docs/evidence/"
  : "skipped: __RUNTIME_DEPLOYER_PRIVATE_KEY is not set; set it for this one command to open and close a position";

describe.skipIf(!KEY)(title, () => {
  let account: PrivateKeyAccount;
  /** The signer's address as this library types an address: viem types its own as the project registers it. */
  let signer: EvmAddress;
  let wallet: WalletClient<Transport, typeof hederaTestnet, PrivateKeyAccount>;
  let sender: MirrorAccount;
  let relay: string;
  let startBalance: Tinybar;
  let preState: EvidenceAccountState;

  const balance = async (): Promise<Tinybar> => toTinybar(await testnetClient.getBalance({ address: account.address }));

  async function withinCeiling(upTo: Tinybar, what: string): Promise<void> {
    assertWithinCeiling({ spent: startBalance - (await balance()), upTo, ceiling: RUN_CEILING, what });
  }

  /** Everything about the account this cycle depends on, read before it starts and again once it is over. */
  async function readState(): Promise<EvidenceAccountState> {
    const [held, found, relationship, lpRelation, serials, allowance, nftApproval] = await Promise.all([
      balance(),
      testnetMirror.getAccount(signer),
      testnetMirror.getTokenRelationship(sender.accountId, sauce.id),
      testnetMirror.getTokenRelationship(sender.accountId, testnet.lpNft.id),
      readPositionSerials(testnetMirror, sender.accountId),
      readManagerAllowance(testnetClient, sauce, signer),
      readNftApproval(testnetClient, signer),
    ]);
    return {
      balanceTinybar: held.toString(),
      balanceHbar: formatHbar(held),
      tokenBalance: (relationship?.balance ?? 0n).toString(),
      maxAutomaticTokenAssociations: signingAccount(found, signer).maxAutomaticTokenAssociations,
      holdsLpNftRelation: lpRelation !== null,
      positions: serials.serials.map(serial => serial.toString()),
      managerAllowance: allowance.toString(),
      nftApproval,
    };
  }

  /** Simulates, signs with viem's default flow, then reads the outcome from the mirror node's DETAIL view. */
  async function send(call: BuiltCall, context?: FailureContext): Promise<MirrorContractResult> {
    try {
      const { request } = await testnetClient.simulateContract({ ...call, account });
      return await confirm(call.functionName, await wallet.writeContract(request));
    } catch (error: unknown) {
      throw failed(error, context);
    }
  }

  /**
   * Signs a call the network will not price, without asking it to. `eth_call` and `eth_estimateGas` both refuse the
   * mint, so there is nothing to simulate: the gas limit comes from the rule the builder already put on the call.
   */
  async function sendWithGasLimit(
    call: BuiltCall & { readonly gas?: bigint },
    context?: FailureContext,
  ): Promise<MirrorContractResult> {
    try {
      return await confirm(call.functionName, await wallet.writeContract({ ...call, account, chain: hederaTestnet }));
    } catch (error: unknown) {
      throw failed(error, context);
    }
  }

  function failed(error: unknown, context?: FailureContext): Error {
    const failure = explainError(error, context);
    return new Error(`${failure.message} (${failure.via})`, { cause: error });
  }

  async function confirm(what: string, hash: `0x${string}`): Promise<MirrorContractResult> {
    console.info(`sent ${what}: ${hash}`);
    const result = await testnetMirror.waitForResult(hash, { timeoutMs: 90_000 });
    const failure = await postMortem(testnetMirror, result);
    if (failure !== null) throw new Error(`${hash} failed on chain: ${failure.message} (${failure.via})`);
    console.info(
      `mirror node: ${result.result}, ${result.gasUsed} gas, ${mirrorBaseUrl}/api/v1/contracts/results/${hash}`,
    );
    return result;
  }

  async function transactionRecord(result: MirrorContractResult): Promise<MirrorTransaction> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const record = await testnetMirror.getTransaction(result.timestamp);
      if (record !== null) return record;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    throw new Error(
      `The mirror node has the result of ${result.hash} but no transaction record at ${result.timestamp}.`,
    );
  }

  async function entry(role: EvidenceRole, result: MirrorContractResult, previewFee: Tinybar) {
    const record = await transactionRecord(result);
    return evidenceTransaction({ role, result, record, sender: sender.accountId, previewFee, mirrorBaseUrl });
  }

  /**
   * The preview a caller is shown before signing, and the ceiling guard that reads it. `functions` names the inner
   * calls of a multicall, so that the mint is priced from its gas rule instead of an estimate nothing will give.
   */
  async function preview(
    call: BuiltCall,
    into: EvidencePreflight[],
    what: string,
    options: { spends?: Tinybar; functions?: readonly string[] } = {},
  ): Promise<Tinybar> {
    const cost = await checkCost(testnetClient, {
      call,
      account: signer,
      autoAssociates: false,
      token: sauce,
      functions: options.functions,
    });
    report(cost, into);
    await withinCeiling(tinybar(cost.fee + (options.spends ?? 0n)), what);
    return cost.fee;
  }

  /**
   * Closes a position the cycle opened but could not finish: whatever is left of it, at whatever price the pool is
   * at. It runs outside the ceiling guard on purpose — leaving HBAR and tokens locked in a position costs more than
   * the gas of closing it — and it never throws, so the failure that brought the run here is the one that is raised.
   */
  async function abandon(): Promise<void> {
    try {
      const { serials } = await readPositionSerials(testnetMirror, sender.accountId);
      const beforeTheCycle = new Set(preState.positions);
      for (const tokenId of serials.filter(serial => !beforeTheCycle.has(serial.toString()))) {
        const open = await readPosition(testnetClient, tokenId);
        if (open === null) continue;
        console.info(`closing position ${tokenId} at any price, after a failure`);
        const minimums = { amount0Min: 0n, amount1Min: 0n, acceptAnyPrice: true };
        const deadline = swapDeadline(DEADLINE_SECONDS);
        if (open.liquidity > 0n) {
          await send(buildDecreaseLiquidity({ tokenId, liquidity: open.liquidity, minimums, deadline }));
        }
        const emptied = await readPosition(testnetClient, tokenId);
        if (emptied !== null && (emptied.tokensOwed0 > 0n || emptied.tokensOwed1 > 0n)) {
          await send(buildSplitCollect({ tokenId, recipient: signer }));
        }
        const approvedForAll = await readNftApproval(testnetClient, signer);
        if (approvedForAll) await send(buildBurn({ tokenId, approvedForAll }));
      }
    } catch (error: unknown) {
      console.info(`the position could not be closed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Re-checks the record the way a reader of docs/evidence/ will, then writes it. */
  async function writeEvidence(
    preflight: EvidencePreflight[],
    position: EvidencePosition,
    transactions: EvidenceTransaction[],
  ): Promise<void> {
    const record: PositionEvidenceRecord = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      name: `position-cycle-${position.tokenId}`,
      network: "testnet",
      chainId: testnet.chainId,
      recordedAt: new Date().toISOString(),
      sender: { evmAddress: toEvmAddress(sender.evmAddress), accountId: sender.accountId },
      software: { viem: viemPackage.version, relay, node: process.version },
      preState,
      postState: await readState(),
      preflight,
      position,
      transactions,
    };
    expect(await checkPositionEvidence(record, testnetMirror)).toEqual([]);
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(path.join(EVIDENCE_DIR, evidenceFileName(record)), `${JSON.stringify(record, null, 2)}\n`);
    console.info(`${position.summary}; written to docs/evidence/${evidenceFileName(record)}`);
  }

  beforeAll(async () => {
    account = privateKeyToAccount(privateKeyOf(KEY ?? ""));
    signer = toEvmAddress(account.address);
    wallet = createWalletClient({ account, chain: hederaTestnet, transport: http(jsonRpcUrl("testnet")) });
    assertTestnet(await testnetClient.getChainId());
    sender = signingAccount(await testnetMirror.getAccount(signer), signer);
    relay = await testnetClient.request({ method: "web3_clientVersion" });
    startBalance = await balance();
    preState = await readState();
    console.info(`signing as ${account.address} (${sender.accountId}), balance ${formatHbar(startBalance)}, ${relay}`);
    console.info(
      `before the cycle: ${formatTokenAmount(BigInt(preState.tokenBalance), sauce)}, manager allowance ` +
        `${formatTokenAmount(BigInt(preState.managerAllowance), sauce)}, NFT approval ${preState.nftApproval}, ` +
        `${preState.positions.length} position(s), ${preState.maxAutomaticTokenAssociations} automatic association slots`,
    );
  });

  // Six transactions and the mirror node's own lag: this one test is the whole cycle, so it gets its own timeout.
  it("opens a position at the live tick, reads it back, collects it as native HBAR and burns it", async () => {
    const preflight: EvidencePreflight[] = [];
    const transactions: EvidenceTransaction[] = [];

    const poolState = await readPoolState(testnetClient, pool);
    const range = narrowRangeAround(poolState.tick, poolState.tickSpacing);
    const { needed } = planDeposit({
      pool,
      sqrtPriceX96: poolState.sqrtPriceX96,
      range,
      hbarTarget: HBAR_TARGET,
      hbarBudget: HBAR_BUDGET,
      tokenBudget: TOKEN_BUDGET,
    });
    const desired = offered(needed, MARGIN_BPS);
    const minimums = minimumsUnder(needed, pool, TOLERANCE_BPS);
    const mintFeeTinybar = await readMintFeeTinybar(testnetClient);
    const hbarAmount = tinybar(desired.hbar);
    const value = mintValue({ hbarAmount, mintFeeTinybar });
    console.info(
      `pool tick ${poolState.tick}, range [${range.tickLower}, ${range.tickUpper}]: the position needs ` +
        `${formatHbar(tinybar(needed.hbar))} and ${formatTokenAmount(needed.token, sauce)}; it offers ` +
        `${formatHbar(hbarAmount)} and ${formatTokenAmount(desired.token, sauce)}, refuses under ` +
        `${TOLERANCE_BPS / 100} %, and the mint fee is ${formatHbar(mintFeeTinybar)}`,
    );

    const mintChecks = {
      client: testnetClient,
      mirror: testnetMirror,
      owner: signer,
      token: sauce,
      tokenAmount: desired.token,
      value: toWeibar(value),
      hbarAmount,
      mintFeeTinybar,
      minimums,
    };
    let checks = await checkPositionMint(mintChecks);
    for (const verdict of checks) report(verdict, preflight);
    if (checks.some(verdict => verdict.check === "manager-allowance" && verdict.status === "fail")) {
      const approve = buildManagerTokenApproval(sauce, desired.token);
      const fee = await preview(approve, preflight, "The approval for the position manager");
      const approved = await send(approve);
      // An HTS approve answers a bool: a transaction that succeeded and returned false approved nothing.
      assertApprovalGranted(approved);
      transactions.push(await entry("approve", approved, fee));
      await expect
        .poll(() => readManagerAllowance(testnetClient, sauce, signer), { timeout: 30_000 })
        .toBe(desired.token);
      checks = await checkPositionMint(mintChecks);
      for (const verdict of checks) report(verdict, preflight);
    }
    assertPreflightPasses(checks, "mint");

    const deadline = swapDeadline(DEADLINE_SECONDS);
    const mint = buildPositionMint({
      pool,
      recipient: signer,
      range,
      tickSpacing: poolState.tickSpacing,
      hbarAmount,
      tokenAmount: desired.token,
      minimums,
      deadline,
      mintFeeTinybar,
      gas: positionMintGasLimit(),
    });
    expect(mint.value).toBe(toWeibar(value));
    const mintFee = await preview(mint, preflight, "The mint", { spends: value, functions: MINT_FUNCTIONS });
    const minted = await sendWithGasLimit(mint, {
      value: mint.value,
      functions: MINT_FUNCTIONS,
      address: mint.address,
    });
    transactions.push(await entry("mint", minted, mintFee));

    try {
      // The position NFT has no enumeration of its own: which serial the mint created comes from the mirror node.
      await expect
        .poll(async () => (await readPositionSerials(testnetMirror, sender.accountId)).serials.length, {
          timeout: 60_000,
        })
        .toBeGreaterThan(preState.positions.length);
      const opened = await readPositionSerials(testnetMirror, sender.accountId);
      const tokenId = newSerial(preState.positions.map(BigInt), opened.serials);
      const held = openedPosition(await readPosition(testnetClient, tokenId), tokenId);
      const deposited = fromPair(
        amountsForLiquidity({ ...range, sqrtPriceX96: poolState.sqrtPriceX96, liquidity: held.liquidity }, "deposit"),
      );
      console.info(
        `position ${tokenId}: ${held.liquidity} of liquidity over [${held.tickLower}, ${held.tickUpper}], ` +
          `${formatHbar(tinybar(deposited.hbar))} and ${formatTokenAmount(deposited.token, sauce)} deposited`,
      );

      const principal = fromPair(
        amountsForLiquidity({ ...range, sqrtPriceX96: poolState.sqrtPriceX96, liquidity: held.liquidity }, "withdraw"),
      );
      const decrease = buildDecreaseLiquidity({
        tokenId,
        liquidity: held.liquidity,
        minimums: minimumsUnder(principal, pool, TOLERANCE_BPS),
        deadline: swapDeadline(DEADLINE_SECONDS),
      });
      const decreaseFee = await preview(decrease, preflight, "The decrease");
      transactions.push(await entry("decrease", await send(decrease), decreaseFee));

      const emptied = assertEmptied(await readPosition(testnetClient, tokenId), tokenId);
      const owed = fromPair({ amount0: emptied.tokensOwed0, amount1: emptied.tokensOwed1 });
      const collect = buildSplitCollect({ tokenId, recipient: signer });
      const collectFee = await preview(collect, preflight, "The collect");
      const collected = await entry("collect", await send(collect), collectFee);
      const hbarReceived = hbarPaidByCollect({
        senderNetTinybar: BigInt(collected.senderNetTinybar),
        feeTinybar: BigInt(collected.feeTinybar),
        owed: owed.hbar,
      });
      transactions.push(collected);
      console.info(`the collect paid ${formatHbar(hbarReceived)} natively and ${formatTokenAmount(owed.token, sauce)}`);

      let burnCheck = report(await checkPositionBurn(testnetClient, signer), preflight);
      if (burnCheck.status === "fail") {
        const approval = buildNftApproval(true);
        const fee = await preview(approval, preflight, "The approval on the position NFT");
        transactions.push(await entry("nft-approve", await send(approval), fee));
        await expect.poll(() => readNftApproval(testnetClient, signer), { timeout: 30_000 }).toBe(true);
        burnCheck = report(await checkPositionBurn(testnetClient, signer), preflight);
      }
      assertPreflightPasses([burnCheck], "burn");

      const burn = buildBurn({ tokenId, approvedForAll: burnCheck.status === "pass" });
      const burnFee = await preview(burn, preflight, "The burn");
      transactions.push(await entry("burn", await send(burn), burnFee));

      await expect
        .poll(async () => (await readPositionSerials(testnetMirror, sender.accountId)).serials.length, {
          timeout: 60_000,
        })
        .toBe(preState.positions.length);
      const left = await readPositionSerials(testnetMirror, sender.accountId);
      assertBurnt(await readPosition(testnetClient, tokenId), left.serials, tokenId);

      await writeEvidence(
        preflight,
        {
          manager: testnet.positionManager.id,
          lpNft: testnet.lpNft.id,
          pool: pool.id,
          poolFee: pool.fee,
          tokenId: tokenId.toString(),
          tickLower: held.tickLower,
          tickUpper: held.tickUpper,
          tickSpacing: poolState.tickSpacing,
          tickAtMint: poolState.tick,
          sqrtPriceX96AtMint: poolState.sqrtPriceX96.toString(),
          liquidity: held.liquidity.toString(),
          toleranceBps: TOLERANCE_BPS,
          amount0Desired: toPair(desired).amount0.toString(),
          amount1Desired: toPair(desired).amount1.toString(),
          amount0Min: minimums.amount0Min.toString(),
          amount1Min: minimums.amount1Min.toString(),
          mintFeeTinybar: mintFeeTinybar.toString(),
          mintValueTinybar: value.toString(),
          depositedHbar: deposited.hbar.toString(),
          depositedToken: deposited.token.toString(),
          collectedHbar: owed.hbar.toString(),
          collectedToken: owed.token.toString(),
          hbarReceivedTinybar: hbarReceived.toString(),
          summary:
            `${formatHbar(tinybar(deposited.hbar))} and ${formatTokenAmount(deposited.token, sauce)} into position ` +
            `${tokenId}, ${formatHbar(hbarReceived)} and ${formatTokenAmount(owed.token, sauce)} back out`,
        },
        transactions,
      );
    } catch (error: unknown) {
      await abandon();
      throw error;
    }
  }, 300_000);
});
