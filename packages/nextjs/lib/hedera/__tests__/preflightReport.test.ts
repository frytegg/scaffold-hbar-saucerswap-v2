import {
  type AccountRef,
  type PreflightOutcome,
  type PreflightReport,
  type ReportSection,
  type SectionId,
  exitCodeOf,
  readAccountRef,
  renderPreflight,
  runPreflight,
} from "../__live__/preflightReport";
import { testnet } from "../addresses";
import { GasRuleError, gasRules, withGasLimit } from "../gasRules";
import { type MirrorClient, MirrorError, type MirrorResponse, createMirrorClient } from "../mirror";
import { mirrorPaths } from "../mirrorPaths";
import { positionManagerAbi } from "../positionAbi";
import { allowanceVerdict, recipientVerdict } from "../preflight";
import { type WireFixture, mirrorFixture, replayClient, replayMirror, rpcFixture } from "./replay";
import { type PublicClient } from "viem";
import { describe, expect, it } from "vitest";

// What the command that answers about an account you choose decides: which read produces which verdict, which paths
// it asks for, and — the half that matters most — what it does when it cannot answer at all. A refusal must never
// read as a verdict about the account, so each refusal path below asserts its own exit code as well as its words.

const MIRROR = "https://testnet.mirrornode.hedera.com";
const RELAY = "https://testnet.hashio.io/api";
const sauce = testnet.sauce;

/** The printed report wraps to a fixed width, so a sentence is matched with its line breaks flattened. */
const flat = (text: string) => text.replace(/\s+/g, " ");

/** A captured answer replayed for any request of its method: these tests are about the report, not about viem. */
function anyRequest(name: string): WireFixture {
  const fixture = rpcFixture(name);
  return { ...fixture, request: { method: fixture.request.method } };
}

/** The HTS facade's answer to allowance(owner, router): one 32-byte word, as the captured zero answer is. */
function allowanceAnswer(units: bigint): WireFixture {
  return {
    request: { method: "eth_call" },
    status: 200,
    body: { jsonrpc: "2.0", id: 1, result: `0x${units.toString(16).padStart(64, "0")}` },
  };
}

/** The mirror node's allowance list for a spender: an empty list once the allowance has been spent. */
function allowanceRow(owner: string, amount: number | null): MirrorResponse {
  const allowances =
    amount === null
      ? []
      : [{ amount, owner, spender: testnet.swapRouter.id, token_id: sauce.id, amount_granted: amount }];
  return { status: 200, body: { allowances, links: { next: null } } };
}

type Account = {
  /** The mirror answer for the account, by its own file name. */
  readonly account: string;
  readonly accountId: string;
  /** The mirror answer for its relation with SAUCE. */
  readonly relation: string;
  /** What the mirror node's allowance list holds for the router, null for no row at all. */
  readonly row: number | null;
  /** What the HTS facade answers for allowance(owner, router). */
  readonly allowance: bigint;
};

/** The report asks about what readAccountRef returned, which for an address is its checksummed form. */
function refOf(typed: string): AccountRef {
  const read = readAccountRef(typed);
  return read.ok ? read.ref : (typed as AccountRef);
}

function answersFor(typed: string, account: Account | null): Record<string, MirrorResponse> {
  const ref = refOf(typed);
  if (account === null) return { [mirrorPaths.account(ref)]: mirrorFixture("account-not-found") };
  return {
    [mirrorPaths.account(ref)]: mirrorFixture(account.account),
    [mirrorPaths.tokenRelationship(account.accountId as `${number}.${number}.${number}`, sauce.id)]: mirrorFixture(
      account.relation,
    ),
    [mirrorPaths.tokenAllowance(account.accountId as `${number}.${number}.${number}`, testnet.swapRouter.id, sauce.id)]:
      allowanceRow(account.accountId, account.row),
  };
}

function clientFor(account: Account | null, httpStatus?: number): PublicClient {
  return replayClient([allowanceAnswer(account?.allowance ?? 0n), anyRequest("gas-price")], httpStatus);
}

async function answer(
  typed: string,
  account: Account | null,
  options: { mirror?: MirrorClient; relayStatus?: number } = {},
): Promise<PreflightOutcome> {
  return runPreflight({
    mirror: options.mirror ?? createMirrorClient({ transport: replayMirror(answersFor(typed, account)) }),
    client: clientFor(account, options.relayStatus),
    typed,
    mirrorBaseUrl: MIRROR,
    relayUrl: RELAY,
  });
}

function reported(outcome: PreflightOutcome): PreflightReport {
  if (!outcome.ok) throw new Error(`the command refused instead of answering: ${outcome.refusal.message}`);
  return outcome.report;
}

function section(report: PreflightReport, id: SectionId): ReportSection {
  const found = report.sections.find(candidate => candidate.id === id);
  if (found === undefined) throw new Error(`no ${id} section`);
  return found;
}

/** The verdict a named function of the library produced, as the report quotes it. */
function verdict(report: PreflightReport, id: SectionId, by: string): { text: string; says?: string } {
  const found = section(report, id).verdicts.find(candidate => candidate.label === by);
  if (found === undefined) throw new Error(`no ${by} verdict in the ${id} section`);
  return found;
}

/** 0.0.10645914: its own EVM address, unlimited automatic associations, and a relation holding 267.077901 SAUCE. */
const HOLDER: Account = {
  account: "account-unlimited-slots",
  accountId: "0.0.10645914",
  relation: "tokens-relation-automatic",
  row: 300_000_000,
  allowance: 300_000_000n,
};
const HOLDER_ADDRESS = "0x3b7a9a1b874dd0994cc4137047dacf2803bb6c01";
const HOLDER_BALANCE = 267_077_901n;

/** 0.0.10650085: holds 46.466682 SAUCE by a relation of its own, and has approved no spender. */
const UNAPPROVED: Account = {
  account: "account-zero-slots-associated",
  accountId: "0.0.10650085",
  relation: "tokens-relation-explicit",
  row: null,
  allowance: 0n,
};
const UNAPPROVED_ADDRESS = "0x0a6f9a4407c2e13f55df69a0281e0fa9c9b040de";

/** 0.0.10574825: exists, has never held SAUCE, and has no automatic association slot to receive it with. */
const NO_RELATION: Account = {
  account: "account-zero-slots-unassociated",
  accountId: "0.0.10574825",
  relation: "tokens-no-relation",
  row: null,
  allowance: 0n,
};
const NO_RELATION_ADDRESS = "0x82756b984e8c34c28c98a3eb6977df106e4b3aac";

/** The same account as HOLDER, before it ever received the token: the reading that asks about a sample amount. */
const NEWCOMER: Account = { ...HOLDER, relation: "tokens-no-relation", row: null, allowance: 0n };

describe("what this command accepts as an account", () => {
  it("takes an address in any case and answers about its checksummed form", () => {
    expect(readAccountRef(`  ${HOLDER_ADDRESS}  `)).toEqual({
      ok: true,
      ref: "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01",
    });
  });

  it("takes a Hedera account id", () => {
    expect(readAccountRef("0.0.10645914")).toEqual({ ok: true, ref: "0.0.10645914" });
  });

  it("refuses an address whose capitals spell another checksum, which is a mistyped digit", () => {
    const mistyped = "0x3b7A9a1B874dd0994cC4137047DAcf2803Bb6c02";
    const read = readAccountRef(mistyped);
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).toContain("one digit of it is wrong");
  });

  it("refuses text that is neither an address nor an id", () => {
    const read = readAccountRef("my wallet");
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).toContain("That is neither an EVM address");
  });

  it("refuses an empty answer, which is what an ended input gives", () => {
    const read = readAccountRef("   ");
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).toContain("Nothing was typed");
  });

  it("refuses an account id no address can hold", () => {
    const read = readAccountRef("0.0.99999999999999999999999");
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).toContain("too large for an address");
  });

  it("exits 1 for every one of those, and prints no verdict", async () => {
    const outcome = await answer("my wallet", HOLDER);
    expect(outcome.ok).toBe(false);
    expect(exitCodeOf(outcome)).toBe(1);
    expect(flat(renderPreflight(outcome))).toContain("Nothing was read: this command was given no account");
  });
});

describe("an account that holds the token and has an allowance", () => {
  it("quotes the pre-flight's own verdicts for what the mirror node and the facade answered", async () => {
    const report = reported(await answer(HOLDER_ADDRESS, HOLDER));
    const mirror = createMirrorClient({ transport: replayMirror(answersFor(HOLDER_ADDRESS, HOLDER)) });
    const account = await mirror.getAccount(refOf(HOLDER_ADDRESS));
    const relationship = await mirror.getTokenRelationship(
      HOLDER.accountId as `${number}.${number}.${number}`,
      sauce.id,
    );

    expect(verdict(report, "recipient", "recipientVerdict").says).toBe(
      recipientVerdict(report.address, account, relationship, sauce).message,
    );
    expect(verdict(report, "allowance", "checkAllowance").says).toBe(
      allowanceVerdict(HOLDER.allowance, HOLDER_BALANCE, sauce).message,
    );
    expect(verdict(report, "allowance", "checkAllowance").text).toContain("answers pass");
  });

  it("asks the allowance question for the whole balance, which the account chose and this command did not", async () => {
    const report = reported(await answer(HOLDER_ADDRESS, HOLDER));
    const asked = section(report, "allowance").read.find(line => line.label === "the amount asked");
    expect(asked?.text).toContain("267.077901 SAUCE");
    expect(asked?.text).toContain("the whole balance above");
  });

  it("shows the mirror node's own allowance row beside the facade's answer", async () => {
    const report = reported(await answer(HOLDER_ADDRESS, HOLDER));
    const row = section(report, "allowance").read.find(line => line.label === "the mirror node");
    expect(row?.text).toContain(`an allowance row of 300 SAUCE for the router (${testnet.swapRouter.id})`);
  });

  it("names the three mirror-node reads it made, and exits 0", async () => {
    const outcome = await answer(HOLDER_ADDRESS, HOLDER);
    expect(exitCodeOf(outcome)).toBe(0);
    expect(reported(outcome).reads).toEqual([
      `${MIRROR}${mirrorPaths.account(refOf(HOLDER_ADDRESS))}`,
      `${MIRROR}${mirrorPaths.tokenRelationship(HOLDER.accountId as `${number}.${number}.${number}`, sauce.id)}`,
      `${MIRROR}${mirrorPaths.tokenAllowance(HOLDER.accountId as `${number}.${number}.${number}`, testnet.swapRouter.id, sauce.id)}`,
    ]);
  });
});

describe("an account that holds the token and has no allowance", () => {
  it("refuses the swap before the wallet opens, and names the amount to approve", async () => {
    const report = reported(await answer(UNAPPROVED_ADDRESS, UNAPPROVED));
    const allowance = verdict(report, "allowance", "checkAllowance");
    expect(allowance.text).toContain("answers fail, do: approve");
    expect(allowance.says).toBe(allowanceVerdict(0n, 46_466_682n, sauce).message);
    expect(verdict(report, "recipient", "recipientVerdict").text).toContain("answers pass");
  });

  it("says that an empty allowance list can be a spent allowance, not only a missing one", async () => {
    const report = reported(await answer(UNAPPROVED_ADDRESS, UNAPPROVED));
    const row = section(report, "allowance").read.find(line => line.label === "the mirror node");
    expect(row?.text).toContain("no allowance row for the router");
    expect(row?.text).toContain("one that has been used up");
  });
});

describe("an account that has never held the token", () => {
  it("refuses it as a recipient when it has no automatic association slot either", async () => {
    const report = reported(await answer(NO_RELATION_ADDRESS, NO_RELATION));
    const recipient = verdict(report, "recipient", "recipientVerdict");
    expect(recipient.text).toContain("answers fail, do: associate");
    expect(recipient.says).toContain("no automatic association slot");
  });

  it("asks the allowance question for a sample amount, and says that it is one", async () => {
    const report = reported(await answer(HOLDER_ADDRESS, NEWCOMER));
    const asked = section(report, "allowance").read.find(line => line.label === "the amount asked");
    expect(asked?.text).toBe("1 SAUCE, a sample, since this account holds none of it");
    expect(verdict(report, "allowance", "checkAllowance").says).toBe(allowanceVerdict(0n, 1_000_000n, sauce).message);
  });

  it("lets an account with unlimited automatic associations through, as the swap itself would", async () => {
    const report = reported(await answer(HOLDER_ADDRESS, NEWCOMER));
    expect(verdict(report, "recipient", "recipientVerdict").text).toContain("answers pass");
    expect(verdict(report, "recipient", "recipientVerdict").says).toContain("unlimited automatic associations");
  });
});

describe("an account that does not exist", () => {
  it("answers about the address rather than failing, and says what would create the account", async () => {
    const outcome = await answer(NO_RELATION_ADDRESS, null);
    expect(exitCodeOf(outcome)).toBe(0);
    const recipient = verdict(reported(outcome), "recipient", "recipientVerdict");
    expect(recipient.text).toContain("answers fail, do: fund");
    expect(recipient.says).toBe(
      recipientVerdict(refOf(NO_RELATION_ADDRESS) as `0x${string}`, null, null, sauce).message,
    );
  });

  it("asks the relay nothing about an allowance, and says why instead of inventing a verdict", async () => {
    const report = reported(await answer(NO_RELATION_ADDRESS, null));
    expect(section(report, "allowance").verdicts).toEqual([]);
    expect(section(report, "allowance").notAsked).toContain("no account here to hold an allowance");
    expect(report.reads).toEqual([`${MIRROR}${mirrorPaths.account(refOf(NO_RELATION_ADDRESS))}`]);
  });

  it("reads an unknown account id at the address form that id would produce", async () => {
    const report = reported(await answer("0.0.10645914", null));
    expect(report.address).toBe("0x0000000000000000000000000000000000a2719a");
    expect(verdict(report, "recipient", "recipientVerdict").says).toContain(
      "0x0000000000000000000000000000000000a2719a",
    );
  });
});

describe("a mirror node that does not answer", () => {
  const unavailable = (): MirrorClient =>
    createMirrorClient({
      transport: path => {
        throw new MirrorError("unavailable", path, null, "The mirror node did not answer.");
      },
      sleep: async () => {},
    });

  const refusedBy = (outcome: PreflightOutcome) => {
    if (outcome.ok) throw new Error("the command answered although the mirror node was down");
    return outcome.refusal;
  };

  it("says a third party is down, exits 2, and never looks like a verdict about the account", async () => {
    const outcome = await answer(HOLDER_ADDRESS, HOLDER, { mirror: unavailable() });
    expect(refusedBy(outcome).kind).toBe("upstream-unavailable");
    expect(exitCodeOf(outcome)).toBe(2);
    const printed = flat(renderPreflight(outcome));
    expect(printed).toContain("a public Hedera endpoint did not answer");
    expect(printed).toContain("it says nothing about the account");
    expect(printed).toContain("The mirror node is unavailable");
  });

  it("treats a run of 5xx answers the same way, after the retries the client makes", async () => {
    const mirror = createMirrorClient({
      transport: async () => ({ status: 503, body: null }),
      sleep: async () => {},
    });
    const outcome = await answer(HOLDER_ADDRESS, HOLDER, { mirror });
    expect(refusedBy(outcome).kind).toBe("upstream-unavailable");
    expect(refusedBy(outcome).message).toContain("HTTP 503");
  });

  it("reports a relay that does not answer in the same way, although the mirror node did", async () => {
    const outcome = await answer(HOLDER_ADDRESS, HOLDER, { relayStatus: 503 });
    expect(refusedBy(outcome).kind).toBe("upstream-unavailable");
    expect(exitCodeOf(outcome)).toBe(2);
    expect(flat(renderPreflight(outcome))).toContain("The JSON-RPC relay did not answer");
  });

  it("reports anything else as its own kind, exits 3, and still claims nothing about the account", async () => {
    const mirror = createMirrorClient({ transport: replayMirror({}) });
    const outcome = await answer(HOLDER_ADDRESS, HOLDER, { mirror });
    expect(refusedBy(outcome).kind).toBe("unexpected");
    expect(exitCodeOf(outcome)).toBe(3);
    expect(flat(renderPreflight(outcome))).toContain("It says nothing about the account either.");
  });
});

describe("the call no simulator prices", () => {
  const rule = gasRules[0];

  it("quotes the builder's own refusal to produce that call without a gas limit", async () => {
    const report = reported(await answer(HOLDER_ADDRESS, HOLDER));
    const refusal = verdict(report, "gas-rule", "withGasLimit");
    const raised = (() => {
      try {
        withGasLimit(
          {
            address: testnet.positionManager.evmAddress,
            abi: positionManagerAbi,
            functionName: "multicall",
            args: [[]],
          },
          { functions: ["mint", "refundETH"] },
        );
        return null;
      } catch (error: unknown) {
        return error instanceof GasRuleError ? error : null;
      }
    })();
    expect(refusal.says).toBe(raised?.message);
    expect(refusal.text).toContain("do: supply-gas");
  });

  it("prices it from the rule's limit and today's gas price, never from an estimate", async () => {
    const report = reported(await answer(HOLDER_ADDRESS, HOLDER));
    const cost = verdict(report, "gas-rule", "checkCost");
    expect(cost.says).toContain("the gas limit this template supplies for a call no simulator prices");
    expect(section(report, "gas-rule").read.find(line => line.label === "the limit")?.text).toContain("1,000,000 gas");
    expect(rule.gasLimit).toBe(1_000_000n);
  });

  it("carries the sentence that explains the wallet's own larger figure", async () => {
    const report = reported(await answer(HOLDER_ADDRESS, HOLDER));
    expect(verdict(report, "gas-rule", "and the wallet").says).toContain("it prices the gas limit");
  });
});

describe("what the command prints", () => {
  it("quotes every sentence the library returned, and the endpoints it read them from", async () => {
    const outcome = await answer(HOLDER_ADDRESS, HOLDER);
    const report = reported(outcome);
    const printed = renderPreflight(outcome);
    for (const { says } of report.sections.flatMap(part => part.verdicts)) {
      if (says !== undefined) expect(printed.replace(/\s+/g, " ")).toContain(says.replace(/\s+/g, " "));
    }
    for (const url of report.reads) expect(printed).toContain(url);
    expect(printed).toContain(RELAY);
  });
});
