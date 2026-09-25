import { mirrorFixture, replayClient, replayMirror, rpcFixture } from "../__tests__/replay";
import { testnet } from "../addresses";
import { type FailureContext, explainError, postMortem } from "../failure";
import { type MirrorResponse, createMirrorClient } from "../mirror";
import { mirrorPaths } from "../mirrorPaths";
import { facadeResultVerdict } from "../preflight";
import { type LabelledLine, REPORT_INDENT, REPORT_WIDTH, renderLines } from "./textReport";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Hex, decodeFunctionResult, parseAbi } from "viem";

// The replay command makes a claim about itself: that every sentence it prints is computed by the library from the
// captured answer beside it, and that none is written into the command. A reader cannot check that claim by
// reading, because a hardcoded sentence and a computed one look identical on screen.
//
// So this command breaks the data on purpose. It takes three captured answers, alters one field in each — in
// memory, never on disk — and runs the same library function over both versions. A sentence that changes with the
// data was computed from it. A sentence that survives its own evidence being falsified was written by hand, and
// this command exits 1 to say so.

const FIXTURES = new URL("../__tests__/fixtures/", import.meta.url);
const ASSOCIATE_ABI = parseAbi(["function associate() returns (uint256 responseCode)"]);

/** One alteration: what was changed, what the library said before, and what it says now. */
export type Tamper = {
  readonly id: "response-code" | "allowance" | "not-estimable";
  readonly title: string;
  /** The captured file the alteration was made to, relative to the fixtures directory. */
  readonly fixture: string;
  /** The field, and the change, in the words a reader can check against the file. */
  readonly change: string;
  readonly captured: string;
  readonly altered: string;
  /** False when the library said the same thing about falsified evidence, which is a defect. */
  readonly changed: boolean;
};

function fixturePath(name: string): URL {
  return new URL(name, FIXTURES);
}

/** The sha-256 of a captured file, read twice: nothing here may write to the files it reads. */
function digestOf(name: string): string {
  return createHash("sha256")
    .update(readFileSync(fixturePath(name)))
    .digest("hex")
    .slice(0, 16);
}

/** A deep copy, so an alteration cannot reach the object the next block reads. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 1. A response code inside a successful transaction. The token service answered 194 into the call result of a
 * transaction the EVM calls a success; change those two bytes to 22 and the verdict has to flip.
 */
function responseCodeTamper(): Tamper {
  const name = "mirror/result-associate-again-194.json";
  const answer = mirrorFixture("result-associate-again-194");
  const read = (fixture: MirrorResponse): string => {
    const callResult = (fixture.body as { call_result: Hex }).call_result;
    const code = decodeFunctionResult({ abi: ASSOCIATE_ABI, functionName: "associate", data: callResult });
    const verdict = facadeResultVerdict(code);
    return `${verdict.status}, do: ${verdict.action} — ${verdict.message}`;
  };

  const falsified = copy(answer);
  // 194 TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT becomes 22 SUCCESS: the operation now claims to have worked.
  (falsified.body as { call_result: Hex }).call_result = `0x${"0".repeat(62)}16`;

  const captured = read(answer);
  const altered = read(falsified);
  return {
    id: "response-code",
    title: "A response code hiding inside a successful transaction",
    fixture: name,
    change: "call_result, the last byte: 0xc2 (194) becomes 0x16 (22)",
    captured,
    altered,
    changed: captured !== altered,
  };
}

/**
 * 2. The swap every simulator accepted. The reason the network refused it survives only in the mirror node's
 * `/actions`, as a response code inside a custom error; change that code and the sentence has to follow it.
 */
async function allowanceTamper(): Promise<Tamper> {
  const name = "mirror/actions-token-to-hbar-no-allowance-292.json";
  const result = mirrorFixture("result-token-to-hbar-no-allowance-292");
  const actions = mirrorFixture("actions-token-to-hbar-no-allowance-292");
  const hash = (result.body as { hash: Hex }).hash;
  const read = async (view: MirrorResponse): Promise<string> => {
    const mirror = createMirrorClient({
      transport: replayMirror({
        [mirrorPaths.contractResult(hash)]: result,
        [mirrorPaths.contractActions(hash)]: view,
      }),
    });
    const sent = await mirror.getContractResult(hash);
    if (sent === null) throw new Error("the captured result no longer parses");
    const failure = await postMortem(mirror, sent);
    return failure === null ? "nothing to report" : `${failure.kind}, do: ${failure.action} — ${failure.message}`;
  };

  const falsified = copy(actions);
  // RespCode(292) SPENDER_DOES_NOT_HAVE_ALLOWANCE becomes RespCode(184) TOKEN_NOT_ASSOCIATED_TO_ACCOUNT: the same
  // custom error, one word of data apart, and it wants the opposite fix from the reader.
  const list = (falsified.body as { actions: { result_data: string | null }[] }).actions;
  for (const action of list) {
    if (typeof action.result_data === "string" && action.result_data.startsWith("0xffb9e6ed")) {
      action.result_data = `0xffb9e6ed${"0".repeat(61)}b8`;
    }
  }

  const captured = await read(actions);
  const altered = await read(falsified);
  return {
    id: "allowance",
    title: "A swap every simulator accepted, and the network refused",
    fixture: name,
    change: "result_data of each REVERT_REASON: RespCode(292) becomes RespCode(184)",
    captured,
    altered,
    changed: captured !== altered,
  };
}

/**
 * 3. The call no wallet can price. What makes it un-priceable is the status the relay names in its error; change
 * that name and the library has to stop calling it un-priceable.
 */
async function notEstimableTamper(): Promise<Tamper> {
  const name = "rpc/estimate-mint-not-estimable.json";
  const fixture = rpcFixture("estimate-mint-not-estimable");
  const context: FailureContext = { address: testnet.positionManager.evmAddress, functions: ["mint"] };

  const read = async (view: typeof fixture): Promise<string> => {
    const request = replayClient([view]).request as unknown as (args: {
      method: string;
      params?: readonly unknown[];
    }) => Promise<unknown>;
    try {
      await request({ method: view.request.method, params: view.request.params });
      return "the relay answered, so there is no failure to explain";
    } catch (error: unknown) {
      const failure = explainError(error, context);
      return `${failure.kind}, do: ${failure.action} — ${failure.message}`;
    }
  };

  const falsified = copy(fixture);
  // INVALID_NFT_ID is what makes this call un-priceable rather than merely broken. Swap it for a status that
  // means something else entirely and watch the advice change with it.
  const error = (falsified.body as { error?: { message?: string } }).error;
  if (error?.message !== undefined) {
    error.message = error.message.replace("INVALID_NFT_ID", "INSUFFICIENT_TOKEN_BALANCE");
  }

  const captured = await read(fixture);
  const altered = await read(falsified);
  return {
    id: "not-estimable",
    title: "A call no wallet can price, because nothing will estimate it",
    fixture: name,
    change: 'the relay\'s error message: "INVALID_NFT_ID" becomes "INSUFFICIENT_TOKEN_BALANCE"',
    captured,
    altered,
    changed: captured !== altered,
  };
}

export type TamperRun = {
  readonly tampers: readonly Tamper[];
  /** Every captured file this command read, with its digest before and after: they must be equal. */
  readonly untouched: readonly { readonly file: string; readonly before: string; readonly after: string }[];
};

export async function tamperCaptured(): Promise<TamperRun> {
  const files = [
    "mirror/result-associate-again-194.json",
    "mirror/result-token-to-hbar-no-allowance-292.json",
    "mirror/actions-token-to-hbar-no-allowance-292.json",
    "rpc/estimate-mint-not-estimable.json",
  ];
  const before = files.map(file => ({ file, digest: digestOf(file) }));
  const tampers = [responseCodeTamper(), await allowanceTamper(), await notEstimableTamper()];
  const untouched = before.map(({ file, digest }) => ({ file, before: digest, after: digestOf(file) }));
  return { tampers, untouched };
}

// ------------------------------------------------------------------------------------------------ the report

const WIDTH = REPORT_WIDTH;
const INDENT = REPORT_INDENT;

function rule(text: string): string[] {
  return ["─".repeat(WIDTH), ` ${text}`, "─".repeat(WIDTH)];
}

function block(tamper: Tamper, index: number, total: number): string[] {
  const lines: LabelledLine[] = [
    { label: "captured", text: `${tamper.fixture}`, says: tamper.captured },
    { label: "altered", text: tamper.change, says: tamper.altered },
    {
      label: "verdict",
      text: tamper.changed
        ? "the sentence changed with the data, so the library computed it"
        : "THE SENTENCE SURVIVED ITS OWN EVIDENCE BEING FALSIFIED: it is written by hand",
    },
  ];
  return ["", ...rule(`${index + 1} of ${total}   ${tamper.title}`), "", ...renderLines(lines), ""];
}

export function renderTamper(run: TamperRun): string {
  const caught = run.tampers.filter(tamper => tamper.changed).length;
  const moved = run.untouched.filter(file => file.before !== file.after);
  const head = [
    "",
    "Three captured answers, each altered by one field, to show that this template's sentences are",
    "computed from the answers and not written into the commands that print them.",
    "",
    ...renderLines([
      {
        label: "how",
        text:
          "each alteration is made to a copy held in memory; the files on disk are read twice and their " +
          "digests compared at the end",
      },
      { label: "network", text: "none. No key, no wallet, no account, nothing signed" },
    ]),
  ].map(line => (line === "" ? "" : line.startsWith("─") || line.startsWith(" ") ? line : `${INDENT}${line}`));

  const tail = [
    ...rule("the result"),
    "",
    ...renderLines([
      {
        label: "sentences",
        text: `${caught} of ${run.tampers.length} changed when the answer changed`,
      },
      {
        label: "files",
        text:
          moved.length === 0
            ? `${run.untouched.length} captured files read, all unchanged on disk (sha-256 compared before and after)`
            : `${moved.length} captured file(s) CHANGED ON DISK, which this command must never do`,
      },
      {
        label: "what it proves",
        text:
          caught === run.tampers.length
            ? "no sentence above is hardcoded: falsify the evidence and the template says something else"
            : "at least one sentence is independent of its evidence, which is a defect in this repository",
      },
    ]),
    "",
  ];

  return [...head, ...run.tampers.flatMap((tamper, index) => block(tamper, index, run.tampers.length)), ...tail].join(
    "\n",
  );
}

export function exitCodeOf(run: TamperRun): number {
  const allChanged = run.tampers.every(tamper => tamper.changed);
  const nothingWritten = run.untouched.every(file => file.before === file.after);
  return allChanged && nothingWritten ? 0 : 1;
}
