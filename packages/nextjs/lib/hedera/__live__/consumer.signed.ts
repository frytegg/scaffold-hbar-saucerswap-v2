import { testnet } from "../addresses";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidencePreflight,
  type EvidenceRecord,
  type EvidenceTransaction,
  checkEvidence,
  evidenceFileName,
  evidenceTransaction,
} from "../evidence";
import { type EvmAddress, toEvmAddress } from "../evmAddress";
import { explainError, postMortem } from "../failure";
import type { MirrorAccount, MirrorContractResult, MirrorTransaction } from "../mirror";
import { type PreflightVerdict, checkCost, checkRecipient } from "../preflight";
import { minimumOut, quoteExactInput, swapDeadline, swapPath } from "../swap";
import { type Tinybar, formatHbar, formatTokenAmount, hbarToTinybar, payable, tinybar, toTinybar } from "../units";
import { assertTestnet, assertWithinCeiling, privateKeyOf, signingAccount } from "./runGuards";
import { EVIDENCE_DIR, mirrorBaseUrl, testnetClient, testnetMirror } from "./testnet";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type Abi,
  type Hex,
  type Transport,
  type WalletClient,
  createWalletClient,
  decodeAbiParameters,
  http,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import viemPackage from "viem/package.json";
import { beforeAll, describe, expect, it } from "vitest";
import deployedContracts from "~~/contracts/deployedContracts";
import { jsonRpcUrl } from "~~/services/hedera/upstreams";

// The Solidity half of the evidence: one swap sent to the contract this repository deploys and verifies, not to the
// router, and recorded together with the transaction that created it. The pre-flight reads the contract's own token
// relation from the mirror node, so the record also shows that the constructor's association worked.

const KEY = process.env.__RUNTIME_DEPLOYER_PRIVATE_KEY;
/** The run refuses a send that could take its spending above this; the swap costs about a quarter of an HBAR. */
const RUN_CEILING = hbarToTinybar("3");
const SLIPPAGE_BPS = 100;
const DEADLINE_SECONDS = 300;
const HBAR_IN = hbarToTinybar("0.05");
/** Sent on top of the amount to swap, so that the refund leg of the contract is exercised and measured. */
const MARGIN = hbarToTinybar("0.01");

const consumer = deployedContracts[testnet.chainId].SaucerSwapHbarConsumer;
const pool = testnet.hbarSaucePool;
const sauce = testnet.sauce;

function report(verdict: PreflightVerdict): EvidencePreflight {
  console.info(`pre-flight ${verdict.check}: ${verdict.status}. ${verdict.message}`);
  return { check: verdict.check, status: verdict.status, message: verdict.message };
}

/** The contract answers `(amountOut, refundedTinybar)`, not the router's array of multicall results. */
function swapReturn(result: MirrorContractResult): { amountOut: bigint; refunded: bigint } {
  if (result.callResult === null) throw new Error(`The mirror node has no return value for ${result.hash}.`);
  const [amountOut, refunded] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], result.callResult);
  return { amountOut, refunded };
}

const title = KEY
  ? "a swap through the deployed Solidity consumer, written to docs/evidence/"
  : "skipped: __RUNTIME_DEPLOYER_PRIVATE_KEY is not set; set it for this one command to sign the swap";

describe.skipIf(!KEY)(title, () => {
  let account: PrivateKeyAccount;
  let signer: EvmAddress;
  let wallet: WalletClient<Transport, typeof hederaTestnet, PrivateKeyAccount>;
  let sender: MirrorAccount;
  let relay: string;
  let startBalance: Tinybar;

  const address = toEvmAddress(consumer.address);

  async function transactionRecord(result: MirrorContractResult): Promise<MirrorTransaction> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const record = await testnetMirror.getTransaction(result.timestamp);
      if (record !== null) return record;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    throw new Error(`The mirror node has the result of ${result.hash} but no record at ${result.timestamp}.`);
  }

  async function entry(
    role: EvidenceTransaction["role"],
    result: MirrorContractResult,
    previewFee: Tinybar,
  ): Promise<EvidenceTransaction> {
    const record = await transactionRecord(result);
    return evidenceTransaction({ role, result, record, sender: sender.accountId, previewFee, mirrorBaseUrl });
  }

  const mirrorJson = async (path: string): Promise<Record<string, unknown>> => {
    const answer = await fetch(`${mirrorBaseUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (answer.status !== 200) throw new Error(`The mirror node answered HTTP ${answer.status} to ${path}.`);
    return (await answer.json()) as Record<string, unknown>;
  };

  /**
   * The transaction that created the contract, and the fee a caller was shown before signing it. A deployment is
   * sent with a fixed gas limit, so that preview is the limit at the gas price of the day, and both come from the
   * mirror node's detail view of the transaction: its list view carries neither.
   */
  async function deployment(): Promise<EvidenceTransaction> {
    const listed = await mirrorJson(`/api/v1/contracts/${address}/results?order=asc&limit=1`);
    const [creation] = (listed.results ?? []) as { hash: Hex }[];
    if (creation === undefined) throw new Error(`The mirror node lists no transaction of ${address}.`);
    const detail = await mirrorJson(`/api/v1/contracts/results/${creation.hash}`);
    const result = await testnetMirror.getContractResult(creation.hash);
    if (result === null) throw new Error(`The mirror node has no result for ${creation.hash}.`);
    return entry("deploy", result, tinybar(BigInt(detail.gas_limit as number) * BigInt(detail.gas_price as Hex)));
  }

  beforeAll(async () => {
    account = privateKeyToAccount(privateKeyOf(KEY ?? ""));
    signer = toEvmAddress(account.address);
    wallet = createWalletClient({ account, chain: hederaTestnet, transport: http(jsonRpcUrl("testnet")) });
    assertTestnet(await testnetClient.getChainId());
    sender = signingAccount(await testnetMirror.getAccount(signer), signer);
    relay = await testnetClient.request({ method: "web3_clientVersion" });
    startBalance = toTinybar(await testnetClient.getBalance({ address: account.address }));
    console.info(`signing as ${account.address} (${sender.accountId}), balance ${formatHbar(startBalance)}, ${relay}`);
  });

  it("swaps HBAR for SAUCE through the contract, which keeps the tokens and returns the margin", async () => {
    const quoted = await quoteExactInput(testnetClient, swapPath(testnet.whbar, pool.fee, sauce), HBAR_IN);
    // The contract was associated by its own constructor: the mirror node is where that is visible.
    const recipient = await checkRecipient(testnetMirror, { recipient: address, token: sauce });
    const preflight = [report(recipient)];
    if (recipient.status === "fail") throw new Error(recipient.message);

    const contract = await testnetMirror.getAccount(address);
    if (contract === null) throw new Error(`The mirror node has no entity at ${address}.`);
    const heldBefore = (await testnetMirror.getTokenRelationship(contract.accountId, sauce.id))?.balance ?? 0n;

    const deadline = swapDeadline(DEADLINE_SECONDS);
    const amountOutMinimum = minimumOut(quoted, SLIPPAGE_BPS);
    const call = {
      address,
      abi: consumer.abi as Abi,
      functionName: "swapExactHbarForToken",
      args: [HBAR_IN, amountOutMinimum, deadline],
      ...payable(tinybar(HBAR_IN + MARGIN)),
    };
    const cost = await checkCost(testnetClient, { call, account: signer, autoAssociates: false, token: sauce });
    preflight.push(report(cost));
    assertWithinCeiling({
      spent: startBalance - toTinybar(await testnetClient.getBalance({ address: account.address })),
      upTo: tinybar(cost.fee + HBAR_IN + MARGIN),
      ceiling: RUN_CEILING,
      what: "The swap through the contract",
    });

    let hash: Hex;
    try {
      const { request } = await testnetClient.simulateContract({ ...call, account });
      hash = await wallet.writeContract(request);
    } catch (error: unknown) {
      const failure = explainError(error, { value: call.value, amountIn: HBAR_IN });
      throw new Error(`${failure.message} (${failure.via})`, { cause: error });
    }
    console.info(`sent swapExactHbarForToken: ${hash}`);
    const result = await testnetMirror.waitForResult(hash, { timeoutMs: 60_000 });
    const failure = await postMortem(testnetMirror, result);
    if (failure !== null) throw new Error(`${hash} failed on chain: ${failure.message} (${failure.via})`);

    const { amountOut, refunded } = swapReturn(result);
    expect(amountOut).toBeGreaterThanOrEqual(amountOutMinimum);
    // The margin came back in the same transaction: the contract keeps no HBAR.
    expect(refunded).toBeGreaterThanOrEqual(MARGIN);
    const heldAfter = (await testnetMirror.getTokenRelationship(contract.accountId, sauce.id))?.balance ?? 0n;
    expect(heldAfter - heldBefore).toBe(amountOut);

    const swap = await entry("swap", result, cost.fee);
    // The sender paid the HBAR the contract swapped and the fee, and nothing else.
    expect(BigInt(swap.senderNetTinybar)).toBe(-(HBAR_IN + BigInt(swap.feeTinybar)));

    const record: EvidenceRecord = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      name: "consumer-hbar-to-sauce",
      network: "testnet",
      chainId: testnet.chainId,
      recordedAt: new Date().toISOString(),
      sender: { evmAddress: toEvmAddress(sender.evmAddress), accountId: sender.accountId },
      software: { viem: viemPackage.version, relay, node: process.version },
      preflight,
      swap: {
        direction: "hbar-to-token",
        router: testnet.swapRouter.id,
        pool: pool.id,
        poolFee: pool.fee,
        tokenIn: "HBAR",
        tokenOut: `${sauce.symbol} ${sauce.id}`,
        amountIn: HBAR_IN.toString(),
        quotedAmountOut: quoted.toString(),
        slippageBps: SLIPPAGE_BPS,
        amountOutMinimum: amountOutMinimum.toString(),
        deadline: deadline.toString(),
        recipient: address,
        amountOut: amountOut.toString(),
        summary: `${formatHbar(HBAR_IN)} -> ${formatTokenAmount(amountOut, sauce)}`,
        via: { contract: contract.accountId, evmAddress: address, function: "swapExactHbarForToken" },
      },
      transactions: [await deployment(), swap],
    };
    expect(await checkEvidence(record, testnetMirror)).toEqual([]);
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(path.join(EVIDENCE_DIR, evidenceFileName(record)), `${JSON.stringify(record, null, 2)}\n`);
    console.info(`${record.swap.summary}; written to docs/evidence/${evidenceFileName(record)}`);
  });
});
