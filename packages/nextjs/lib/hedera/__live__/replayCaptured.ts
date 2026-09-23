import { mirrorFixture, readFixture, replayClient, replayMirror, rpcFixture } from "../__tests__/replay";
import { testnet } from "../addresses";
import { toEvmAddress } from "../evmAddress";
import { type FailureContext, explainContractResult, explainError, postMortem } from "../failure";
import { gasRules, largestMeasuredGas, withGasLimit } from "../gasRules";
import { type MirrorClient, type MirrorContractResult, createMirrorClient } from "../mirror";
import { mirrorPaths } from "../mirrorPaths";
import { positionManagerAbi } from "../positionAbi";
import { checkAllowance, facadeResultVerdict } from "../preflight";
import { extractRpcError } from "../rpcError";
import { formatHbar, tinybar } from "../units";
import { readFileSync } from "node:fs";
import { type Hex, decodeFunctionResult, parseAbi } from "viem";
import { hashscanTransactionUrl, mirrorResultUrl } from "~~/components/hedera/links";

// The zero-setup way in. Three failures this project met on Hedera testnet, replayed here from the answers captured
// at the time: what a developer's own tools said, then what this template says instead, then the transaction each
// one comes from.
//
// Nothing here writes a sentence about a failure. Every line of `template` below is the return value of the library,
// computed while this runs from the captured answer next to it, so this file cannot drift from what the app shows.
// The relay's answers are replayed through the pinned viem by `__tests__/replay.ts`, the same mechanism the unit
// tests use; the mirror node's are replayed through a transport that answers from the captured files. No request
// leaves this process: `replayCaptured.test.ts` asserts that with a global fetch that throws.

/** One fact of a block: a short label, what happened, and — for this template's half — the sentence it produced. */
export type ReplayLine = {
  readonly label: string;
  readonly text: string;
  /** A sentence the library produced just now, quoted verbatim. */
  readonly says?: string;
};

export type ReplayProof = {
  readonly label: string;
  readonly hash: Hex;
  readonly mirrorUrl: string;
  readonly hashscanUrl: string;
};

export type ReplayBlockId = "allowance" | "not-estimable" | "response-code";

export type ReplayBlock = {
  readonly id: ReplayBlockId;
  readonly title: string;
  /** The captured files this block is built from, relative to `lib/hedera/__tests__/fixtures/`. */
  readonly fixtures: readonly string[];
  /** What standard tooling reports: the wallet's version of the story. */
  readonly tooling: readonly ReplayLine[];
  /** What this template answers for the same call, produced by the library while this runs. */
  readonly template: readonly ReplayLine[];
  readonly proof: readonly ReplayProof[];
};

/** The account every capture was made from: 0.0.10645914, this project's own testnet account. */
const CAPTURE_SENDER = toEvmAddress("0x3b7a9a1b874dd0994cc4137047dacf2803bb6c01");
/** The `amountIn` of the captured token → HBAR swap, read off its calldata: 10 SAUCE, which has 6 decimals. */
const CAPTURED_AMOUNT_IN = 10_000_000n;

const FIXTURES = new URL("../__tests__/fixtures/", import.meta.url);

/** A captured wallet file, which carries what the wallet displayed as well as what it handed back to the page. */
type WalletFixture = {
  readonly wallet: string;
  readonly display?: string;
  readonly error?: { readonly message: string };
  readonly rows?: readonly {
    readonly label: string;
    readonly hash: Hex;
    readonly result: string;
    readonly gasLimit: number;
    readonly gasUsed: number;
    readonly feeTinybar: number;
    readonly walletShownHbar: string;
    readonly mirrorUrl: string;
    readonly hashscanUrl: string;
  }[];
};

function walletFixture(name: string): WalletFixture {
  return JSON.parse(readFileSync(new URL(`wallet/${name}.json`, FIXTURES), "utf8")) as WalletFixture;
}

type LooseRequest = (args: { method: string; params?: readonly unknown[] }) => Promise<unknown>;

/**
 * Sends the relay exactly the request one capture recorded and returns what it answered, or the error the pinned
 * viem built from it. The replay transport refuses any other request, so this cannot quietly ask something else.
 */
async function replayRequest(name: string): Promise<{ result?: unknown; error?: unknown }> {
  const fixture = rpcFixture(name);
  const request = replayClient([fixture]).request as unknown as LooseRequest;
  try {
    return { result: await request({ method: fixture.request.method, params: fixture.request.params }) };
  } catch (error: unknown) {
    return { error };
  }
}

/** The mirror node's DETAIL view of one captured transaction, with its `/actions` when the capture kept them. */
async function replayMirrorResult(
  result: string,
  actions?: string,
): Promise<{ mirror: MirrorClient; sent: MirrorContractResult }> {
  const answer = mirrorFixture(result);
  const hash = (answer.body as { hash: Hex }).hash;
  const answers = { [mirrorPaths.contractResult(hash)]: answer };
  if (actions !== undefined) answers[mirrorPaths.contractActions(hash)] = mirrorFixture(actions);
  const mirror = createMirrorClient({ transport: replayMirror(answers) });
  const sent = await mirror.getContractResult(hash);
  if (sent === null) throw new Error(`The captured mirror answer ${result} holds no contract result.`);
  return { mirror, sent };
}

function proofOf(label: string, hash: Hex): ReplayProof {
  return { label, hash, mirrorUrl: mirrorResultUrl(hash), hashscanUrl: hashscanTransactionUrl(hash) };
}

function thousands(value: bigint | number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** What a caller knows about a call, which is what decides whether a gas limit is the right advice. */
const MINT_MULTICALL: FailureContext = {
  address: testnet.positionManager.evmAddress,
  functions: ["mint", "refundETH"],
};
const TOKEN_SWAP: FailureContext = {
  address: testnet.swapRouter.evmAddress,
  functions: ["exactInput", "unwrapWHBAR"],
};

async function allowanceBlock(): Promise<ReplayBlock> {
  const simulated = await replayRequest("call-token-to-hbar-allowance-zero");
  const estimated = await replayRequest("estimate-token-to-hbar-allowance-zero");
  const verdict = await checkAllowance(replayClient([readFixture("call-allowance-router-zero")]), {
    token: testnet.sauce,
    owner: CAPTURE_SENDER,
    amountIn: CAPTURED_AMOUNT_IN,
  });
  const { mirror, sent } = await replayMirrorResult(
    "result-token-to-hbar-no-allowance-292",
    "actions-token-to-hbar-no-allowance-292",
  );
  const afterwards = await postMortem(mirror, sent);
  const wallet = walletFixture("metamask-fee-display");
  const walletRow = wallet.rows?.find(row => row.result !== "SUCCESS" && row.label.includes("allowance"));
  if (afterwards === null || walletRow === undefined) {
    throw new Error("The captured answers no longer hold a swap the network refused for a missing allowance.");
  }
  if (typeof simulated.result !== "string" || typeof estimated.result !== "string") {
    throw new Error("The captured simulators no longer accept the swap this block is about.");
  }

  return {
    id: "allowance",
    title: "A swap every simulator accepted, and the network refused",
    fixtures: [
      "rpc/call-token-to-hbar-allowance-zero.json",
      "rpc/estimate-token-to-hbar-allowance-zero.json",
      "rpc/call-allowance-router-zero.json",
      "mirror/result-token-to-hbar-no-allowance-292.json",
      "mirror/actions-token-to-hbar-no-allowance-292.json",
      "wallet/metamask-fee-display.json",
    ],
    tooling: [
      {
        label: "eth_call",
        text: `answered ${(simulated.result.length - 2) / 2} bytes of result, not an error: the swap simulates cleanly`,
      },
      {
        label: "eth_estimateGas",
        text: `answered ${thousands(BigInt(estimated.result))} gas, so the wallet had a fee to show`,
      },
      {
        label: wallet.wallet.split(" on ")[0],
        text: `announced ${walletRow.walletShownHbar} HBAR, a Confirm button and no warning of any kind`,
      },
      {
        label: "the network",
        text: `${sent.result}, and the revert data a receipt can read is "${sent.errorMessage}"`,
      },
      {
        label: "afterwards",
        text: `the wallet listed "Interaction failed" and nothing else; ${formatHbar(tinybar(BigInt(walletRow.feeTinybar)))} was charged for ${thousands(walletRow.gasUsed)} gas and nothing arrived`,
      },
    ],
    template: [
      {
        label: "before the send",
        text: `checkAllowance reads the allowance keylessly and answers ${verdict.status}, do: ${verdict.action}`,
        says: verdict.message,
      },
      {
        label: "if it is sent",
        text: `postMortem reads /actions, where the multicall's erased reason survives: ${afterwards.code} ${afterwards.statusName}, do: ${afterwards.action}`,
        says: afterwards.message,
      },
    ],
    proof: [
      proofOf("the swap a browser wallet sent, and lost", walletRow.hash),
      proofOf("the same miss from a script, whose /actions were captured", sent.hash),
    ],
  };
}

async function notEstimableBlock(): Promise<ReplayBlock> {
  const simulated = await replayRequest("call-mint-not-estimable");
  const estimated = await replayRequest("estimate-mint-not-estimable");
  const wallet = walletFixture("metamask-send-refused-no-gas-limit");
  if (wallet.error === undefined || wallet.display === undefined) {
    throw new Error("The captured wallet refusal no longer holds what the wallet displayed.");
  }
  const advised = explainError(wallet.error, MINT_MULTICALL);
  const control = explainError(wallet.error, TOKEN_SWAP);
  const rule = gasRules.find(candidate => candidate.functions.includes("mint"));
  if (rule === undefined) throw new Error("No gas rule covers the position mint any more.");

  let refusedToBuild: unknown;
  try {
    withGasLimit(
      { address: testnet.positionManager.evmAddress, abi: positionManagerAbi, functionName: "multicall", args: [[]] },
      { functions: ["mint", "refundETH"] },
    );
  } catch (error: unknown) {
    refusedToBuild = error;
  }
  const refusal = explainError(refusedToBuild);
  if (refusal.action !== "supply-gas") throw new Error("withGasLimit no longer refuses a call it cannot price.");

  return {
    id: "not-estimable",
    title: "A call no wallet can price, because nothing will estimate it",
    fixtures: [
      "rpc/call-mint-not-estimable.json",
      "rpc/estimate-mint-not-estimable.json",
      "wallet/metamask-send-refused-no-gas-limit.json",
    ],
    tooling: [
      { label: "eth_call", text: `refused it: "${extractRpcError(simulated.error).message}"` },
      { label: "eth_estimateGas", text: `refused it the same way: "${extractRpcError(estimated.error).message}"` },
      { label: wallet.wallet.split(" on ")[0], text: wallet.display },
      {
        label: "what it handed back",
        text: `"${wallet.error.message}" — a sentence that names no cause: this relay answers every JSON-RPC error with an HTTP error, so a nonce, a balance or a rate limit wears it too`,
      },
      { label: "the network", text: "executes that very call, which is why the feature is lost and not the HBAR" },
    ],
    template: [
      {
        label: "before the send",
        text: `withGasLimit refuses to build the call at all: ${refusal.kind}, do: ${refusal.action}`,
        says: refusal.message,
      },
      {
        label: "so it is sent with",
        text: `${thousands(rule.gasLimit)} gas, the rule's own limit, above the ${thousands(largestMeasuredGas(rule))} the same call used in the executions below`,
      },
      {
        label: "if a wallet refuses",
        text: `explainError reads the wallet's own sentence as ${advised.kind}, do: ${advised.action}`,
        says: advised.message,
      },
      {
        label: "and the control",
        text: `the same sentence for a call no rule covers is ${control.kind}, do: ${control.action} — advising a gas limit there would send a transaction the network refuses and charges for`,
      },
    ],
    proof: rule.measurements
      .slice(-2)
      .map(measurement => proofOf(`the same mint, sent by ${measurement.sentBy}`, measurement.hash)),
  };
}

const ASSOCIATE_ABI = parseAbi(["function associate() returns (uint256 responseCode)"]);

async function responseCodeBlock(): Promise<ReplayBlock> {
  const { sent } = await replayMirrorResult("result-associate-again-194");
  // The EVM status word, which the library never reads because it says nothing here: it is what a receipt shows.
  const { status } = mirrorFixture("result-associate-again-194").body as { status: string };
  if (sent.callResult === null) throw new Error("The captured association no longer carries a return value.");
  const code = decodeFunctionResult({ abi: ASSOCIATE_ABI, functionName: "associate", data: sent.callResult });
  const verdict = facadeResultVerdict(code);
  const nothingToExplain = explainContractResult(sent);

  return {
    id: "response-code",
    title: "A response code hiding inside a successful transaction",
    fixtures: ["mirror/result-associate-again-194.json"],
    tooling: [
      { label: "the receipt", text: `status ${status}, and the mirror node agrees: ${sent.result}` },
      { label: "a block explorer", text: "a green tick, like any other transaction of the account" },
      { label: "the fee", text: `${thousands(sent.gasUsed)} gas, charged in full` },
      { label: "what happened", text: "nothing at all: the operation was refused and the transaction still succeeded" },
    ],
    template: [
      {
        label: "the failure path",
        text: `explainContractResult finds ${nothingToExplain === null ? "nothing to report: by every EVM rule this transaction worked" : "a failure"}`,
      },
      {
        label: "the return value",
        text: `facadeResultVerdict reads the ${code} the token service answered and answers ${verdict.status}, do: ${verdict.action}`,
        says: verdict.message,
      },
    ],
    proof: [proofOf("an account associating itself with a token it already held", sent.hash)],
  };
}

/** The three blocks, each built by running the library over the answers captured for it. */
export async function replayBehaviours(): Promise<readonly ReplayBlock[]> {
  return [await allowanceBlock(), await notEstimableBlock(), await responseCodeBlock()];
}

const WIDTH = 96;
const INDENT = "  ";
const MAX_LABEL = 22;

function wrapped(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") current = word;
    else if (`${current} ${word}`.length <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

function renderLines(entries: readonly ReplayLine[]): string[] {
  const labelWidth = Math.min(MAX_LABEL, Math.max(...entries.map(entry => entry.label.length)));
  const gutter = `${INDENT}  ${" ".repeat(labelWidth)}  `;
  return entries.flatMap(entry => {
    const head = `${INDENT}  ${entry.label.padEnd(labelWidth)}  `;
    const body = wrapped(entry.text, WIDTH - gutter.length).map((line, index) =>
      index === 0 ? `${head}${line}` : `${gutter}${line}`,
    );
    const quote =
      entry.says === undefined
        ? []
        : wrapped(`"${entry.says}"`, WIDTH - gutter.length - 2).map(line => `${gutter}  ${line}`);
    return [...body, ...quote];
  });
}

function renderBlock(block: ReplayBlock, index: number, total: number): string[] {
  return [
    "",
    "─".repeat(WIDTH),
    ` ${index + 1} of ${total}   ${block.title}`,
    "─".repeat(WIDTH),
    "",
    `${INDENT}What your own tools report`,
    ...renderLines(block.tooling),
    "",
    `${INDENT}What this template says instead`,
    ...renderLines(block.template),
    "",
    `${INDENT}The transaction${block.proof.length > 1 ? "s" : ""} it comes from`,
    ...block.proof.flatMap(proof => [
      `${INDENT}  ${proof.label}`,
      `${INDENT}    ${proof.hashscanUrl}`,
      `${INDENT}    ${proof.mirrorUrl}`,
    ]),
    "",
  ];
}

/** The report, as one string: one block per behaviour, in the order a developer meets them. */
export function renderReport(blocks: readonly ReplayBlock[]): string {
  const fixtures = new Set(blocks.flatMap(block => block.fixtures));
  return [
    "",
    "Three things Hedera does that standard tooling reports wrongly, or not at all.",
    "",
    `${INDENT}Every answer below was captured from Hedera testnet and is replayed here: no network, no key, no`,
    `${INDENT}wallet, no account, nothing signed. Every sentence in quotes was produced by this template's own`,
    `${INDENT}library, just now, from the captured answer above it: none is written into this command.`,
    ...blocks.flatMap((block, index) => renderBlock(block, index, blocks.length)),
    "─".repeat(WIDTH),
    "",
    `${INDENT}${fixtures.size} captured answers replayed, from lib/hedera/__tests__/fixtures/.`,
    `${INDENT}The test:unit script asserts these same answers as tests; the evidence:check script re-reads every`,
    `${INDENT}transaction above from the public mirror node without a key; and docs/hedera-behaviour.md carries`,
    `${INDENT}every behaviour in full, with what each mistake costs and the code that refuses it.`,
    "",
  ].join("\n");
}
