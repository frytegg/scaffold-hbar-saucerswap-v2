import { testnet } from "../addresses";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidencePreflight,
  type EvidenceRecord,
  type EvidenceSwap,
  type EvidenceTransaction,
  checkEvidence,
  evidenceFileName,
  evidenceTransaction,
} from "../evidence";
import { type HbarInputContext, explainError, postMortem } from "../failure";
import type { MirrorAccount, MirrorContractResult, MirrorTransaction } from "../mirror";
import { type PreflightVerdict, checkAllowance, checkCost, checkRecipient, readAllowance } from "../preflight";
import {
  type ApproveCall,
  type SwapCall,
  approvalGranted,
  buildApproveCall,
  buildHbarToTokenSwap,
  buildTokenToHbarSwap,
  minimumOut,
  quoteExactInput,
  swapAmountOut,
  swapDeadline,
  swapPath,
} from "../swap";
import { type Tinybar, formatHbar, formatTokenAmount, hbarToTinybar, tinybar, toTinybar } from "../units";
import { EVIDENCE_DIR, mirrorBaseUrl, testnetClient, testnetMirror } from "./testnet";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Hex, type Transport, type WalletClient, createWalletClient, getAddress, http } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import viemPackage from "viem/package.json";
import { beforeAll, describe, expect, it } from "vitest";
import { jsonRpcUrl } from "~~/services/hedera/upstreams";

// Tier 4: two swaps signed and sent on Hedera testnet through this library, each written to docs/evidence/ once the
// mirror node confirms it. The key comes from the environment of this one command, never from a file.

const KEY = process.env.__RUNTIME_DEPLOYER_PRIVATE_KEY;
/** The run refuses a send that could take its spending above this. Both swaps and an approval cost about 2 HBAR. */
const RUN_CEILING = hbarToTinybar("5");
const SLIPPAGE_BPS = 100;
const DEADLINE_SECONDS = 300;
const HBAR_IN = hbarToTinybar("0.1");
const SAUCE_IN = 1_000_000n;

const pool = testnet.hbarSaucePool;
const sauce = testnet.sauce;

function privateKeyOf(value: string): Hex {
  const key = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("__RUNTIME_DEPLOYER_PRIVATE_KEY is not a 32-byte private key in hexadecimal.");
  }
  return key as Hex;
}

function report(verdict: PreflightVerdict): EvidencePreflight {
  console.info(`pre-flight ${verdict.check}: ${verdict.status}. ${verdict.message}`);
  return { check: verdict.check, status: verdict.status, message: verdict.message };
}

const title = KEY
  ? "signed swaps on Hedera testnet, written to docs/evidence/"
  : "skipped: __RUNTIME_DEPLOYER_PRIVATE_KEY is not set; set it for this one command to sign the two swaps";

describe.skipIf(!KEY)(title, () => {
  let account: PrivateKeyAccount;
  let wallet: WalletClient<Transport, typeof hederaTestnet, PrivateKeyAccount>;
  let sender: MirrorAccount;
  let relay: string;
  let startBalance: Tinybar;

  const balance = async (): Promise<Tinybar> => toTinybar(await testnetClient.getBalance({ address: account.address }));

  async function assertWithinCeiling(upTo: Tinybar, what: string): Promise<void> {
    const spent = startBalance - (await balance());
    if (spent + upTo > RUN_CEILING) {
      throw new Error(
        `${what} may cost up to ${formatHbar(upTo)}, and this run has already spent ${spent} tinybar: that could ` +
          `go over the run's ceiling of ${formatHbar(RUN_CEILING)}. Nothing was sent.`,
      );
    }
  }

  /** Simulates, signs with viem's default flow, then reads the outcome from the mirror node's DETAIL view. */
  async function send(call: SwapCall | ApproveCall, context?: HbarInputContext): Promise<MirrorContractResult> {
    let hash: Hex;
    try {
      // One branch per call type, so that each request is checked against its own ABI.
      if (call.functionName === "approve") {
        const { request } = await testnetClient.simulateContract({ ...call, account });
        hash = await wallet.writeContract(request);
      } else {
        const { request } = await testnetClient.simulateContract({ ...call, account });
        hash = await wallet.writeContract(request);
      }
    } catch (error: unknown) {
      const failure = explainError(error, context);
      throw new Error(`${failure.message} (${failure.via})`, { cause: error });
    }
    console.info(`sent ${call.functionName}: ${hash}`);
    const result = await testnetMirror.waitForResult(hash, { timeoutMs: 60_000 });
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

  function amountOutOf(result: MirrorContractResult): bigint {
    if (result.callResult === null) throw new Error(`The mirror node has no return value for ${result.hash}.`);
    return swapAmountOut(result.callResult);
  }

  async function entry(role: EvidenceTransaction["role"], result: MirrorContractResult, previewFee: Tinybar) {
    const record = await transactionRecord(result);
    return evidenceTransaction({ role, result, record, sender: sender.accountId, previewFee, mirrorBaseUrl });
  }

  /** Re-checks the record the way a reader of docs/evidence/ will, then writes it. */
  async function writeEvidence(
    name: string,
    preflight: EvidencePreflight[],
    swap: EvidenceSwap,
    transactions: EvidenceTransaction[],
  ): Promise<void> {
    const record: EvidenceRecord = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      name,
      network: "testnet",
      chainId: testnet.chainId,
      recordedAt: new Date().toISOString(),
      sender: { evmAddress: getAddress(sender.evmAddress), accountId: sender.accountId },
      software: { viem: viemPackage.version, relay, node: process.version },
      preflight,
      swap,
      transactions,
    };
    expect(await checkEvidence(record, testnetMirror)).toEqual([]);
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const file = path.join(EVIDENCE_DIR, evidenceFileName(record));
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    console.info(`${swap.summary}; written to docs/evidence/${evidenceFileName(record)}`);
  }

  beforeAll(async () => {
    account = privateKeyToAccount(privateKeyOf(KEY ?? ""));
    wallet = createWalletClient({ account, chain: hederaTestnet, transport: http(jsonRpcUrl("testnet")) });
    const chainId = await testnetClient.getChainId();
    if (chainId !== testnet.chainId) {
      throw new Error(
        `The JSON-RPC relay serves chain ${chainId}, not Hedera testnet (${testnet.chainId}). Nothing was signed.`,
      );
    }
    const found = await testnetMirror.getAccount(account.address);
    if (found === null) throw new Error(`No Hedera testnet account has the address ${account.address}: fund it first.`);
    sender = found;
    relay = await testnetClient.request({ method: "web3_clientVersion" });
    startBalance = await balance();
    console.info(`signing as ${account.address} (${sender.accountId}), balance ${formatHbar(startBalance)}, ${relay}`);
  });

  it("HBAR -> SAUCE: quote, recipient check, cost preview, swap, mirror post-check", async () => {
    const quoted = await quoteExactInput(testnetClient, swapPath(testnet.whbar, pool.fee, sauce), HBAR_IN);
    const recipient = await checkRecipient(testnetMirror, { recipient: sender.evmAddress, token: sauce });
    const preflight = [report(recipient)];
    if (recipient.status === "fail") throw new Error(recipient.message);

    const deadline = swapDeadline(DEADLINE_SECONDS);
    const call = buildHbarToTokenSwap({
      pool,
      recipient: sender.evmAddress,
      slippageBps: SLIPPAGE_BPS,
      deadline,
      amountIn: HBAR_IN,
      quotedAmountOut: quoted,
    });
    const cost = await checkCost(testnetClient, {
      call,
      account: account.address,
      autoAssociates: recipient.autoAssociates,
      token: sauce,
    });
    preflight.push(report(cost));
    await assertWithinCeiling(tinybar(cost.fee + HBAR_IN), "The swap");

    const result = await send(call, { value: call.value, amountIn: HBAR_IN });
    const amountOut = amountOutOf(result);
    expect(amountOut).toBeGreaterThanOrEqual(minimumOut(quoted, SLIPPAGE_BPS));
    const swap = await entry("swap", result, cost.fee);
    // The sender paid the HBAR it swapped and the fee, nothing else.
    expect(BigInt(swap.senderNetTinybar)).toBe(-(HBAR_IN + BigInt(swap.feeTinybar)));

    await writeEvidence(
      "hbar-to-sauce",
      preflight,
      {
        direction: "hbar-to-token",
        router: testnet.swapRouter.id,
        pool: pool.id,
        poolFee: pool.fee,
        tokenIn: "HBAR",
        tokenOut: `${sauce.symbol} ${sauce.id}`,
        amountIn: HBAR_IN.toString(),
        quotedAmountOut: quoted.toString(),
        slippageBps: SLIPPAGE_BPS,
        amountOutMinimum: minimumOut(quoted, SLIPPAGE_BPS).toString(),
        deadline: deadline.toString(),
        recipient: getAddress(sender.evmAddress),
        amountOut: amountOut.toString(),
        summary: `${formatHbar(HBAR_IN)} -> ${formatTokenAmount(amountOut, sauce)}`,
      },
      [swap],
    );
  });

  it("SAUCE -> HBAR: allowance pre-flight, exact approval, swap, native HBAR received", async () => {
    const held = (await testnetMirror.getTokenRelationship(sender.accountId, sauce.id))?.balance ?? 0n;
    if (held < SAUCE_IN) {
      throw new Error(
        `${sender.accountId} holds ${formatTokenAmount(held, sauce)}; this swap needs ${formatTokenAmount(SAUCE_IN, sauce)}.`,
      );
    }
    const quoted = tinybar(await quoteExactInput(testnetClient, swapPath(sauce, pool.fee, testnet.whbar), SAUCE_IN));
    const transactions: EvidenceTransaction[] = [];

    const allowance = await checkAllowance(testnetClient, { token: sauce, owner: account.address, amountIn: SAUCE_IN });
    const preflight = [report(allowance)];
    if (allowance.status === "fail") {
      const approve = buildApproveCall(sauce, SAUCE_IN);
      const approveCost = await checkCost(testnetClient, {
        call: approve,
        account: account.address,
        autoAssociates: false,
        token: sauce,
      });
      preflight.push(report(approveCost));
      await assertWithinCeiling(approveCost.fee, "The approval");
      const approved = await send(approve);
      if (approved.callResult === null || !approvalGranted(approved.callResult)) {
        throw new Error(`${approved.hash} succeeded but the token's approve did not return true.`);
      }
      const approval = await entry("approve", approved, approveCost.fee);
      expect(BigInt(approval.senderNetTinybar)).toBe(-BigInt(approval.feeTinybar));
      transactions.push(approval);
      await expect.poll(() => readAllowance(testnetClient, sauce, account.address), { timeout: 30_000 }).toBe(SAUCE_IN);
    }

    const deadline = swapDeadline(DEADLINE_SECONDS);
    const call = buildTokenToHbarSwap({
      pool,
      recipient: sender.evmAddress,
      slippageBps: SLIPPAGE_BPS,
      deadline,
      amountIn: SAUCE_IN,
      quotedAmountOut: quoted,
    });
    const cost = await checkCost(testnetClient, {
      call,
      account: account.address,
      autoAssociates: false,
      token: sauce,
      hbarOut: quoted,
    });
    preflight.push(report(cost));
    await assertWithinCeiling(cost.fee, "The swap");

    const result = await send(call);
    const amountOut = amountOutOf(result);
    expect(amountOut).toBeGreaterThanOrEqual(minimumOut(quoted, SLIPPAGE_BPS));
    const swap = await entry("swap", result, cost.fee);
    // The HBAR arrived as native HBAR: the sender's net movement plus the fee it paid is exactly amountOut.
    expect(BigInt(swap.senderNetTinybar) + BigInt(swap.feeTinybar)).toBe(amountOut);
    transactions.push(swap);

    await writeEvidence(
      "sauce-to-hbar",
      preflight,
      {
        direction: "token-to-hbar",
        router: testnet.swapRouter.id,
        pool: pool.id,
        poolFee: pool.fee,
        tokenIn: `${sauce.symbol} ${sauce.id}`,
        tokenOut: "HBAR",
        amountIn: SAUCE_IN.toString(),
        quotedAmountOut: quoted.toString(),
        slippageBps: SLIPPAGE_BPS,
        amountOutMinimum: minimumOut(quoted, SLIPPAGE_BPS).toString(),
        deadline: deadline.toString(),
        recipient: getAddress(sender.evmAddress),
        amountOut: amountOut.toString(),
        summary: `${formatTokenAmount(SAUCE_IN, sauce)} -> ${formatHbar(tinybar(amountOut))}`,
      },
      transactions,
    );
  });
});
