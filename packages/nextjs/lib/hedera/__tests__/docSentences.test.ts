import {
  type BuiltCall,
  type EntityId,
  type EvmAddress,
  type MirrorAccount,
  WALLET_FEE_NOTE,
  allowanceVerdict,
  buildSplitCollect,
  costVerdict,
  facadeResultVerdict,
  nftApprovalVerdict,
  payable,
  positionManagerAbi,
  recipientVerdict,
  testnet,
  tinybar,
  withGasLimit,
} from "..";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The page quotes nine sentences of this library, one per documented behaviour, with `{…}` where a call fills a
 * value in. They were copied by hand and nothing compared them: `check-snippets` type-checks the fenced example and
 * `check-symbols` checks the names, and neither reads prose inside a table cell, so a message reworded in the source
 * would leave the page quietly wrong. Each row below is asserted twice — the quote is on the page character for
 * character, and the library says it for inputs chosen here — so a change to either side fails.
 */
const PAGE = fileURLToPath(new URL("../../../../../docs/use-the-checks-in-your-app.md", import.meta.url));

/** The header cell of the column whose rows are the behaviours, as `tools/checks/check-traps.mjs` also reads it. */
const BEHAVIOUR_COLUMN = "behaviour";

const ADDRESS = "0x3b7a9a1b874dd0994cc4137047dacf2803bb6c02" as EvmAddress;
const LONG_ZERO = "0x0000000000000000000000000000000000001234" as EvmAddress;
const ACCOUNT_ID = "0.0.4660" as EntityId;

const unassociated: MirrorAccount = {
  accountId: ACCOUNT_ID,
  evmAddress: ADDRESS,
  maxAutomaticTokenAssociations: 0,
  balance: tinybar(100_000_000n),
};

const mintWithoutGas: BuiltCall = {
  address: testnet.positionManager.evmAddress,
  abi: positionManagerAbi,
  functionName: "mint",
  args: [],
};

/**
 * @param act a call that is expected to refuse
 * @returns the message of what it threw
 */
function refusal(act: () => unknown): string {
  try {
    act();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("this call was expected to refuse and did not");
}

/** The quote as a pattern: every `{name}` is what the call filled in, the rest is the library's own wording. */
function patternOf(quote: string): RegExp {
  const escaped = quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\{[A-Za-z]+\\\}/g, "[^\\n]+?")}$`);
}

/** The rows of the page's table, in the order it writes them, whole lines so a quote can be looked for anywhere. */
function tableRows(): string[] {
  const lines = readFileSync(PAGE, "utf8").split(/\r?\n/);
  const header = lines.findIndex(line => line.trim().startsWith(`| ${BEHAVIOUR_COLUMN} |`));
  expect(header).toBeGreaterThan(-1);
  const rows: string[] = [];
  for (let index = header + 2; index < lines.length && lines[index].trim().startsWith("|"); index += 1) {
    rows.push(lines[index]);
  }
  return rows;
}

type Quote = {
  /** The row of the table, counting from one, in the order it shares with `docs/hedera-behaviour.md`. */
  readonly row: number;
  /** The sentence exactly as the page writes it. */
  readonly quote: string;
  /** The same sentence from the library, for inputs chosen here. */
  readonly said: () => string;
};

const QUOTES: Quote[] = [
  {
    row: 1,
    quote:
      "The SaucerSwap router has no allowance to spend your {symbol}. Approve {amountIn} first: without it the " +
      "network rejects the swap and still charges the gas.",
    said: () => allowanceVerdict(0n, 1_000_000n, testnet.sauce).message,
  },
  {
    row: 2,
    quote:
      "{functions} on {contract} cannot be estimated on Hedera: eth_call and eth_estimateGas answered " +
      '"CONTRACT_REVERT_EXECUTED, INVALID_NFT_ID" on 2026-09-22 (relay/0.78.5), and a wallet that cannot price a ' +
      "call will not send it. Pass gas: this template sends {gasLimit}, above the {gasUsed} gas the same call used " +
      "in the executions the rule lists. See packages/nextjs/lib/hedera/gasRules.ts.",
    said: () => refusal(() => withGasLimit(mintWithoutGas, { functions: ["mint"] })),
  },
  {
    row: 3,
    quote: "Network fee: up to {fee}, the gas limit this template supplies for a call no simulator prices.",
    said: () =>
      costVerdict({
        gas: 1_000_000n,
        gasPrice: 1_000_000_000_000n,
        autoAssociates: false,
        token: testnet.sauce,
        source: "gas-rule",
      }).message,
  },
  {
    row: 3,
    quote:
      "Your wallet announces about the same figure, because it prices the gas limit at the current gas price. The " +
      "network charges only the gas the call uses, so what leaves the account is smaller on every transaction this " +
      "project has measured.",
    said: () => WALLET_FEE_NOTE,
  },
  {
    row: 4,
    quote:
      "This collect puts no floor on the HBAR it unwraps, and unwrapWHBAR sends whatever the manager holds: with a " +
      "floor of zero, a collect that pulled nothing still succeeds and is charged its whole gas. Pass what the " +
      "position is owed on the HBAR side, a tolerance under it, or acceptAnyAmount: true.",
    said: () => refusal(() => buildSplitCollect({ tokenId: 361n, recipient: ADDRESS, hbarMinimum: tinybar(0n) })),
  },
  {
    row: 5,
    quote:
      "The position manager is not approved on SSV2-LP, and a burn moves the position NFT back to it. Send " +
      "setApprovalForAll first: simulation accepts the burn either way and the network answers HederaFail(292) " +
      "after charging the gas.",
    said: () => nftApprovalVerdict(false).message,
  },
  {
    row: 6,
    quote:
      "The transaction value, {value} weibar ({value} HBAR), does not cover amountIn, {amountIn} tinybar " +
      "({amountIn} HBAR). Transaction values are weibar: pass amountIn × 10^10.",
    said: () => refusal(() => payable(tinybar(1n), tinybar(2n))),
  },
  {
    row: 7,
    quote:
      "{account} is not associated with {symbol} and has no automatic association slot, so the swap would revert " +
      "and still charge the gas. Associate {symbol} from that account first.",
    said: () => recipientVerdict(ADDRESS, unassociated, null, testnet.sauce).message,
  },
  {
    row: 8,
    quote:
      "{recipient} is the long-zero form of {account}, which has its own EVM address {evmAddress}. Pass that " +
      "address: the network refuses the long-zero form of such an account (INVALID_ALIAS_KEY).",
    said: () => recipientVerdict(LONG_ZERO, unassociated, null, testnet.sauce).message,
  },
  {
    row: 9,
    quote:
      "The transaction succeeded but the HTS operation returned 194 (TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT). The " +
      "account was already associated with this token: nothing changed, and the call was still charged.",
    said: () => facadeResultVerdict(194n).message,
  },
];

describe("the sentences docs/use-the-checks-in-your-app.md quotes", () => {
  it.each(QUOTES)("row $row quotes the page character for character", ({ row, quote }) => {
    expect(tableRows()[row - 1]).toContain(quote);
  });

  it.each(QUOTES)("row $row is what the library answers", ({ quote, said }) => {
    expect(said()).toMatch(patternOf(quote));
  });

  it("reads every row of the table, so an unread row cannot pass the checks above", () => {
    const rows = tableRows();
    expect(rows).toHaveLength(9);
    expect(new Set(QUOTES.map(entry => entry.row))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });

  it("would report a sentence the library no longer says", () => {
    expect(patternOf("Network fee: up to {fee}.").test("Network fee: up to 1.14 HBAR.")).toBe(true);
    expect(patternOf("Network fee: up to {fee}.").test("Network fee: about 1.14 HBAR.")).toBe(false);
    expect(patternOf("a {value} b").test("a  b")).toBe(false);
  });
});
