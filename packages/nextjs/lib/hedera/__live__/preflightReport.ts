import { longZeroAddressOf } from "../addressForms";
import { type EntityId, testnet } from "../addresses";
import { type EvmAddress, isEvmAddress, toEvmAddress } from "../evmAddress";
import { type FailureAction, explainError } from "../failure";
import { gasRuleFor, largestMeasuredGas, withGasLimit } from "../gasRules";
import type { MirrorAccount, MirrorClient, MirrorTokenRelationship } from "../mirror";
import { mirrorPaths } from "../mirrorPaths";
import { positionManagerAbi } from "../positionAbi";
import { checkAllowance, checkCost, recipientVerdict } from "../preflight";
import { formatHbar, formatTokenAmount } from "../units";
import { REPORT_INDENT, REPORT_WIDTH, renderLines, thousands, wrapped } from "./textReport";
import type { PublicClient } from "viem";

// The checks of this template, asked about an account the reader names rather than one this repository chose. It
// reads that account on the public mirror node and prices the call no simulator will price through the JSON-RPC
// relay. Both are third parties; no key, no wallet and no signature are involved at any point.
//
// Nothing here writes a sentence about an account. Every quoted sentence is a return value of the library —
// recipientVerdict, checkAllowance, withGasLimit read through explainError, checkCost — computed while the command
// runs from the reads printed above it, so this report cannot say something a page would not.

/** What the command was given: an EVM address, or the Hedera account id the mirror node resolves to one. */
export type AccountRef = EntityId | EvmAddress;

const ENTITY_ID = /^\d+\.\d+\.\d+$/;

/** The amount the allowance question is asked for when the account holds none of the token: one whole SAUCE. */
const SAMPLE_AMOUNT_IN = 1_000_000n;

/** The functions of the call no simulator prices: the position manager's multicall, for the mint inside it. */
const MINT_FUNCTIONS = ["mint", "refundETH"] as const;

const MINT_CALL = {
  address: testnet.positionManager.evmAddress,
  abi: positionManagerAbi,
  functionName: "multicall",
  args: [[]],
} as const;

/** One labelled thing this run read, or one verdict the library returned, with its sentence quoted verbatim. */
export type ReportLine = { readonly label: string; readonly text: string; readonly says?: string };

export type SectionId = "recipient" | "allowance" | "gas-rule";

export type ReportSection = {
  readonly id: SectionId;
  readonly title: string;
  /** What was read, and from which endpoint. */
  readonly read: readonly ReportLine[];
  /** The library's own verdicts for this account: the status, the action, and the sentence it returned. */
  readonly verdicts: readonly ReportLine[];
  /** Why this section asked for no verdict, when it asked for none. Null when every check of it ran. */
  readonly notAsked: string | null;
};

export type PreflightReport = {
  /** What the reader typed, quoted back, so that a transcript says what it is an answer about. */
  readonly typed: string;
  readonly ref: AccountRef;
  /** The address every check ran for: the one the account's own record names, or the one that was typed. */
  readonly address: EvmAddress;
  readonly account: MirrorAccount | null;
  readonly sections: readonly ReportSection[];
  /** The mirror-node URLs this run read, so that the reader can open the same answers. */
  readonly reads: readonly string[];
  /** The JSON-RPC relay the allowance and the gas price came from. */
  readonly relayUrl: string;
};

export type RefusalKind = "not-an-account" | "upstream-unavailable" | "unexpected";

export type PreflightRefusal = {
  readonly kind: RefusalKind;
  readonly typed: string;
  readonly message: string;
  /** Where the sentence came from: the library's own `via`, or this command reading what it was given. */
  readonly via: string;
};

export type PreflightOutcome =
  | { readonly ok: true; readonly report: PreflightReport }
  | { readonly ok: false; readonly refusal: PreflightRefusal };

/**
 * What the command exits with. A verdict about the account is a successful run whatever that verdict says; each
 * non-zero code means no verdict was reached, and names who did not answer.
 */
export const PREFLIGHT_EXIT_CODES = {
  /** A report was printed. */
  report: 0,
  /** What was typed is neither an address nor an account id, so nothing was read. */
  "not-an-account": 1,
  /** Hedera's public mirror node or its JSON-RPC relay did not answer. */
  "upstream-unavailable": 2,
  /** Anything else went wrong before an answer existed. */
  unexpected: 3,
} as const;

export function exitCodeOf(outcome: PreflightOutcome): number {
  return outcome.ok ? PREFLIGHT_EXIT_CODES.report : PREFLIGHT_EXIT_CODES[outcome.refusal.kind];
}

export type RefTyped =
  | { readonly ok: true; readonly ref: AccountRef }
  | { readonly ok: false; readonly message: string };

/**
 * Reads what was typed as an address or as an account id. A mixed-case address must carry the checksum its capitals
 * spell, which is how a mistyped digit stops here instead of costing gas; an account id must have an address form.
 */
export function readAccountRef(typed: string): RefTyped {
  const text = typed.trim();
  if (text === "") {
    return {
      ok: false,
      message:
        "Nothing was typed. This command answers about one account, named either by its EVM address (0x and 40 " +
        "hexadecimal digits) or by its Hedera account id (shard.realm.number, such as 0.0.1234).",
    };
  }
  if (ENTITY_ID.test(text)) {
    const id = text as EntityId;
    if (longZeroAddressOf(id) === null) {
      return {
        ok: false,
        message: `${id} is shaped like an account id, and a part of it is too large for an address.`,
      };
    }
    return { ok: true, ref: id };
  }
  if (isEvmAddress(text, { strict: false })) {
    try {
      return { ok: true, ref: toEvmAddress(text) };
    } catch {
      return {
        ok: false,
        message:
          `${text} has the 40 hexadecimal digits of an EVM address, and does not carry the checksum its capitals ` +
          "spell: one digit of it is wrong. Pass it in lower case, or as the wallet that owns it shows it.",
      };
    }
  }
  return {
    ok: false,
    message:
      "That is neither an EVM address (0x and 40 hexadecimal digits) nor a Hedera account id " +
      "(shard.realm.number, such as 0.0.1234). Nothing was read.",
  };
}

function slotsOf(account: MirrorAccount): string {
  const slots = account.maxAutomaticTokenAssociations;
  if (slots === -1) return "unlimited automatic associations";
  if (slots === 0) return "no automatic association slot";
  return `${slots} automatic association slots`;
}

function verdictLine(by: string, verdict: { status: string; action: FailureAction; message: string }): ReportLine {
  return { label: by, text: `answers ${verdict.status}, do: ${verdict.action}`, says: verdict.message };
}

function recipientSection(
  address: EvmAddress,
  account: MirrorAccount | null,
  relationship: MirrorTokenRelationship | null,
): ReportSection {
  const token = testnet.sauce;
  const read: ReportLine[] = [
    {
      label: "the account",
      text:
        account === null
          ? `the mirror node has no account at ${address}`
          : `${account.accountId}, whose own address is ${account.evmAddress}, with ${slotsOf(account)} and ` +
            `${formatHbar(account.balance)}`,
    },
  ];
  if (account !== null) {
    read.push({
      label: `the ${token.symbol} relation`,
      text:
        relationship === null
          ? `none: ${account.accountId} has never held ${token.symbol} (${token.id})`
          : `holds ${formatTokenAmount(relationship.balance, token)}, associated ` +
            `${relationship.automaticAssociation ? "automatically, inside a transfer" : "by a transaction of its own"}`,
    });
  }
  return {
    id: "recipient",
    title: `Can a swap pay ${token.symbol} to this account?`,
    read,
    verdicts: [verdictLine("recipientVerdict", recipientVerdict(address, account, relationship, token))],
    notAsked: null,
  };
}

async function allowanceSection(
  client: PublicClient,
  mirror: MirrorClient,
  account: MirrorAccount | null,
  relationship: MirrorTokenRelationship | null,
): Promise<ReportSection> {
  const token = testnet.sauce;
  const router = testnet.swapRouter;
  const title = `May the SaucerSwap router spend this account's ${token.symbol}?`;
  if (account === null) {
    return {
      id: "allowance",
      title,
      read: [],
      verdicts: [],
      notAsked: "There is no account here to hold an allowance, so the relay was asked nothing.",
    };
  }

  const held = relationship?.balance ?? 0n;
  const amountIn = held > 0n ? held : SAMPLE_AMOUNT_IN;
  const granted = await mirror.getTokenAllowance(account.accountId, router.id, token.id);

  return {
    id: "allowance",
    title,
    read: [
      {
        label: "the amount asked",
        text:
          held > 0n
            ? `${formatTokenAmount(amountIn, token)}, the whole balance above: the largest swap this account could ` +
              "make with what it holds"
            : `${formatTokenAmount(amountIn, token)}, a sample, since this account holds none of it`,
      },
      {
        label: "the mirror node",
        text:
          granted === 0n
            ? `no allowance row for the router (${router.id}). The mirror node drops the row once an allowance is ` +
              "spent, so this is either no approval or one that has been used up"
            : `an allowance row of ${formatTokenAmount(granted, token)} for the router (${router.id})`,
      },
    ],
    verdicts: [
      verdictLine("checkAllowance", await checkAllowance(client, { token, owner: account.evmAddress, amountIn })),
    ],
    notAsked: null,
  };
}

async function gasRuleSection(client: PublicClient, address: EvmAddress): Promise<ReportSection> {
  const rule = gasRuleFor(testnet.positionManager.evmAddress, MINT_FUNCTIONS);
  if (rule === null) throw new Error("No gas rule covers the position mint any more.");

  let refusedToBuild: unknown;
  try {
    withGasLimit(MINT_CALL, { functions: MINT_FUNCTIONS });
  } catch (error: unknown) {
    refusedToBuild = error;
  }
  const refusal = explainError(refusedToBuild);
  if (refusal.action !== "supply-gas") throw new Error("withGasLimit no longer refuses a call it cannot price.");
  const cost = await checkCost(client, {
    call: MINT_CALL,
    account: address,
    autoAssociates: false,
    token: testnet.lpNft,
    functions: MINT_FUNCTIONS,
  });

  return {
    id: "gas-rule",
    title: "What does the call no simulator prices cost, at today's gas price?",
    read: [
      {
        label: "the rule",
        text:
          `${rule.functions.join(", ")} on ${rule.contract}: both simulators answered "${rule.simulatorAnswer}" on ` +
          `${rule.observedOn} (${rule.relayVersion}), so a wallet is shown no fee and will not send the call`,
      },
      {
        label: "the limit",
        text:
          `${thousands(rule.gasLimit)} gas, above the ${thousands(largestMeasuredGas(rule))} the same call used ` +
          `in the ${rule.measurements.length} executions the rule carries`,
      },
      {
        label: "the gas price",
        text: "read from the relay just now, which is what makes the figure below today's rather than a constant",
      },
    ],
    verdicts: [
      {
        label: "withGasLimit",
        text: `refuses to build the call: ${refusal.kind}, do: ${refusal.action}`,
        says: refusal.message,
      },
      verdictLine("checkCost", cost),
      { label: "and the wallet", text: "prices that limit, not the gas the call uses", says: cost.walletNote },
    ],
    notAsked: null,
  };
}

/** Every check, for one account. The mirror node is read first, so an outage there costs no relay request. */
export async function buildReport({
  mirror,
  client,
  typed,
  ref,
  mirrorBaseUrl,
  relayUrl,
}: {
  mirror: MirrorClient;
  client: PublicClient;
  typed: string;
  ref: AccountRef;
  mirrorBaseUrl: string;
  relayUrl: string;
}): Promise<PreflightReport> {
  const token = testnet.sauce;
  const paths = [mirrorPaths.account(ref)];
  const account = await mirror.getAccount(ref);
  const relationship = account === null ? null : await mirror.getTokenRelationship(account.accountId, token.id);
  if (account !== null) {
    paths.push(
      mirrorPaths.tokenRelationship(account.accountId, token.id),
      mirrorPaths.tokenAllowance(account.accountId, testnet.swapRouter.id, token.id),
    );
  }

  // An account id becomes the address its own record names, which is the address a caller must pay it at; an id the
  // mirror node does not know has only the form AccountId.toSolidityAddress() would produce. An address that was
  // typed is never rewritten into another form: the long-zero form of an account that has an address of its own is
  // a verdict recipientVerdict gives, not a mistake this command silently corrects.
  const address = ENTITY_ID.test(ref)
    ? (account?.evmAddress ?? (longZeroAddressOf(ref as EntityId) as EvmAddress))
    : (ref as EvmAddress);

  return {
    typed,
    ref,
    address,
    account,
    sections: [
      recipientSection(address, account, relationship),
      await allowanceSection(client, mirror, account, relationship),
      await gasRuleSection(client, address),
    ],
    reads: paths.map(path => `${mirrorBaseUrl}${path}`),
    relayUrl,
  };
}

/**
 * The whole command, as a value. A third party that does not answer is a refusal of its own, never a verdict about
 * the account: the exit code says which of the two happened.
 */
export async function runPreflight(input: {
  mirror: MirrorClient;
  client: PublicClient;
  typed: string;
  mirrorBaseUrl: string;
  relayUrl: string;
}): Promise<PreflightOutcome> {
  const read = readAccountRef(input.typed);
  if (!read.ok) {
    const refusal = {
      kind: "not-an-account" as const,
      typed: input.typed,
      message: read.message,
      via: "what this command was given",
    };
    return { ok: false, refusal };
  }
  try {
    return { ok: true, report: await buildReport({ ...input, ref: read.ref }) };
  } catch (error: unknown) {
    const failure = explainError(error);
    const transient = failure.kind === "unavailable" || failure.kind === "rate-limited";
    return {
      ok: false,
      refusal: {
        kind: transient ? "upstream-unavailable" : "unexpected",
        typed: input.typed,
        message: failure.message,
        via: failure.via,
      },
    };
  }
}

const WIDTH = REPORT_WIDTH;
const INDENT = REPORT_INDENT;

function paragraph(text: string): string[] {
  return wrapped(text, WIDTH - INDENT.length).map(line => `${INDENT}${line}`);
}

function renderSection(section: ReportSection, index: number, total: number): string[] {
  const body =
    section.notAsked === null
      ? [
          `${INDENT}What was read`,
          ...renderLines(section.read),
          "",
          `${INDENT}What the library answers`,
          ...renderLines(section.verdicts),
        ]
      : [`${INDENT}Not asked`, `${INDENT}  ${section.notAsked}`];
  return ["", "─".repeat(WIDTH), ` ${index + 1} of ${total}   ${section.title}`, "─".repeat(WIDTH), "", ...body, ""];
}

function renderReportBody(report: PreflightReport): string[] {
  const resolved =
    report.account === null
      ? "no account. Every answer below is what this template says about an address nobody has funded yet"
      : `account ${report.account.accountId}, and every check below ran for ${report.address}`;
  return [
    "",
    `What this template answers about ${report.typed}, read from Hedera testnet just now.`,
    "",
    ...paragraph(
      "Every sentence in quotes below was returned by lib/hedera while this command ran, from the reads printed " +
        "above it: the same verdicts, the same actions and the same words a page shows for the address a wallet " +
        "connects. Nothing was signed, no key was read and no transaction was sent.",
    ),
    "",
    ...renderLines([
      { label: "you typed", text: report.typed },
      { label: "read as", text: resolved },
    ]),
    ...report.sections.flatMap((section, index) => renderSection(section, index, report.sections.length)),
    "─".repeat(WIDTH),
    "",
    `${INDENT}Read for this answer, keylessly. Open them yourself:`,
    ...report.reads.map(url => `${INDENT}  ${url}`),
    ...paragraph(`The allowance and the gas price came from the JSON-RPC relay at ${report.relayUrl}.`),
    ...paragraph(
      "The test:unit script asserts these same verdicts against captured answers, and the replay script prints the " +
        "three failures they come from with no network at all.",
    ),
    "",
  ];
}

const REFUSAL_HEADLINES: Record<RefusalKind, (typed: string) => string> = {
  "not-an-account": () => "Nothing was read: this command was given no account to answer about.",
  "upstream-unavailable": typed =>
    `Nothing was read about ${typed}: a public Hedera endpoint did not answer. That is a third party being down, ` +
    "and it says nothing about the account.",
  unexpected: typed =>
    `No answer was reached about ${typed}, and not for a reason this command expects. It says nothing about the ` +
    "account either.",
};

function renderRefusalBody(refusal: PreflightRefusal): string[] {
  const again =
    refusal.kind === "upstream-unavailable"
      ? [...paragraph("Run it again in a moment: the public mirror node and the relay are third parties."), ""]
      : [];
  const typed = refusal.typed.trim();
  return [
    "",
    ...paragraph(REFUSAL_HEADLINES[refusal.kind](typed || "what was typed")),
    "",
    ...renderLines([
      ...(typed === "" ? [] : [{ label: "you typed", text: typed }]),
      { label: "why", text: `from ${refusal.via}`, says: refusal.message },
    ]),
    "",
    ...again,
  ];
}

/** The report, or the refusal, as one string ready to print. */
export function renderPreflight(outcome: PreflightOutcome): string {
  return (outcome.ok ? renderReportBody(outcome.report) : renderRefusalBody(outcome.refusal)).join("\n");
}

/**
 * What to say about an account passed after the command name, where this command never looks for one: empty when
 * nothing was passed. The question is the only way in, because an argument does not survive the script name under
 * every package manager — but one that does arrive here is named rather than dropped without a word, which is the
 * mistake this whole template is about.
 */
export function renderIgnoredArguments(commandLine: readonly string[]): string {
  const given = commandLine.map(argument => argument.trim()).filter(argument => argument !== "");
  if (given.length === 0) return "";
  return [
    "",
    ...paragraph(
      `${given.join(" ")} ${given.length === 1 ? "was" : "were"} passed after the command name, and this command ` +
        "reads no arguments: it asks for the account on standard input, because an argument does not survive the " +
        "script name under every package manager. Type it at the question below, or pipe it in.",
    ),
  ].join("\n");
}
