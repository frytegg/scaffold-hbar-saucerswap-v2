// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectDoc, newestEvidence, renderEvidenceBlock } from "../check-evidence.mjs";
import { parseMarkdown } from "../lib/markdown.mjs";

// The figures of the template's first evidence run, 22 Sept 2026: the two records trimmed to what docs quote.
const HBAR_TO_SAUCE = "docs/evidence/2026-09-22-hbar-to-sauce.json";
const SAUCE_TO_HBAR = "docs/evidence/2026-09-22-sauce-to-hbar.json";

/** @returns {Record<string, import("../check-evidence.mjs").EvidenceRecord>} */
function records() {
  const software = { viem: "2.39.0", relay: "relay/0.78.5" };
  return {
    [HBAR_TO_SAUCE]: {
      recordedAt: "2026-09-22T15:57:21.522Z",
      software,
      swap: {
        direction: "hbar-to-token",
        amountIn: "10000000",
        amountOut: "4643294",
        tokenOut: "SAUCE 0.0.1183558",
        summary: "0.1 HBAR -> 4.643294 SAUCE",
      },
      transactions: [
        {
          role: "swap",
          result: "SUCCESS",
          feeTinybar: "21804796",
          previewFeeTinybar: "24452658",
          senderNetTinybar: "-31804796",
        },
      ],
    },
    [SAUCE_TO_HBAR]: {
      recordedAt: "2026-09-22T15:57:30.887Z",
      software,
      swap: {
        direction: "token-to-hbar",
        amountIn: "1000000",
        amountOut: "2140750",
        tokenOut: "HBAR",
        summary: "1 SAUCE -> 0.0214075 HBAR",
      },
      transactions: [
        {
          role: "approve",
          result: "SUCCESS",
          feeTinybar: "79222944",
          previewFeeTinybar: "89212980",
          senderNetTinybar: "-79222944",
        },
        {
          role: "swap",
          result: "SUCCESS",
          feeTinybar: "99717124",
          previewFeeTinybar: "110563584",
          senderNetTinybar: "-97576374",
        },
      ],
    },
  };
}

const BLOCK = [
  "<!-- checks:evidence -->",
  `What one run cost, measured on 22 Sept 2026 through relay/0.78.5 with viem 2.39.0 (\`${HBAR_TO_SAUCE}\` and \`${SAUCE_TO_HBAR}\`):`,
  "",
  "| transaction | network fee | cost preview shown before signing | outcome |",
  "| --- | --- | --- | --- |",
  "| swap 0.1 HBAR for SAUCE | 0.21804796 HBAR | up to 0.24452658 HBAR | 4.643294 SAUCE |",
  "| approve 1 SAUCE for the router | 0.79222944 HBAR | up to 0.8921298 HBAR | returned `true` |",
  "| swap 1 SAUCE for HBAR | 0.99717124 HBAR | up to 1.10563584 HBAR | 0.0214075 HBAR, native |",
  "",
  "2.00744864 HBAR of fees in all; the account's HBAR balance fell by 2.08604114 HBAR, the fees plus the 0.1 HBAR swapped minus the 0.0214075 HBAR received.",
  "<!-- /checks:evidence -->",
];

const TRACKED = [HBAR_TO_SAUCE, SAUCE_TO_HBAR, "docs/evidence/README.md"];

/**
 * @param {string[]} lines
 * @param {Record<string, import("../check-evidence.mjs").EvidenceRecord>} [byFile]
 * @param {string[]} [tracked]
 */
function inspect(lines, byFile = records(), tracked = TRACKED) {
  const doc = parseMarkdown("README.md", ["# Live checks", "", ...lines].join("\n"));
  return inspectDoc(doc, newestEvidence(tracked), file => byFile[file]);
}

test("a block that quotes the newest records with their exact figures passes", () => {
  assert.deepEqual(inspect(BLOCK), []);
});

test("the rendering is the block itself: every figure comes from the files, the totals from their sums", () => {
  const { lines, problems } = renderEvidenceBlock(
    [HBAR_TO_SAUCE, SAUCE_TO_HBAR].map(file => ({ file, record: records()[file] })),
  );
  assert.deepEqual(lines, BLOCK.slice(1, -1));
  assert.deepEqual(problems, []);
});

test("a record whose first transaction is the deployment renders it as one, not as a swap", () => {
  const file = "docs/evidence/2026-09-22-consumer-hbar-to-sauce.json";
  const { lines, problems } = renderEvidenceBlock([
    {
      file,
      record: {
        recordedAt: "2026-09-22T22:39:17.275Z",
        software: { viem: "2.39.0", relay: "relay/0.78.5" },
        swap: {
          direction: "hbar-to-token",
          amountIn: "5000000",
          amountOut: "2321545",
          tokenOut: "SAUCE 0.0.1183558",
          summary: "0.05 HBAR -> 2.321545 SAUCE",
          via: { contract: "0.0.10671897" },
        },
        transactions: [
          {
            role: "deploy",
            result: "SUCCESS",
            feeTinybar: "154330702",
            previewFeeTinybar: "342000000",
            senderNetTinybar: "-154330702",
          },
          {
            role: "swap",
            result: "SUCCESS",
            feeTinybar: "23072139",
            previewFeeTinybar: "27011502",
            senderNetTinybar: "-28072139",
          },
        ],
      },
    },
  ]);
  assert.deepEqual(problems, []);
  assert.equal(lines[4], "| deploy 0.0.10671897 | 1.54330702 HBAR | up to 3.42 HBAR | `SUCCESS` |");
  assert.equal(lines[5], "| swap 0.05 HBAR for SAUCE | 0.23072139 HBAR | up to 0.27011502 HBAR | 2.321545 SAUCE |");
  assert.equal(
    lines.at(-1),
    "1.77402841 HBAR of fees in all; the account's HBAR balance fell by 1.82402841 HBAR, the fees plus the 0.05 " +
      "HBAR swapped.",
  );
});

test("a figure typed differently from its file is refused at its line, with the line the file gives", () => {
  const edited = BLOCK.map(line => line.replace("0.79222944 HBAR |", "0.79 HBAR |"));
  const findings = inspect(edited);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 9);
  assert.match(findings[0].message, /the files give: \| approve 1 SAUCE for the router \| 0\.79222944 HBAR \|/);
});

test("a fee that changed in a file changes its row and the total, and a net movement it no longer explains", () => {
  const byFile = records();
  byFile[SAUCE_TO_HBAR].transactions[1].feeTinybar = "99717125";
  const findings = inspect(BLOCK, byFile);
  assert.deepEqual(
    findings.map(finding => finding.line),
    [3, 10, 12],
  );
  assert.match(findings[0].message, /is not their fees plus the HBAR swapped minus the HBAR received/);
  assert.match(findings[1].message, /the files give: \| swap 1 SAUCE for HBAR \| 0\.99717125 HBAR \|/);
  assert.match(findings[2].message, /the files give: 2\.00744865 HBAR of fees in all/);
});

test("a doc that names an older record of a scenario is refused, inside or outside a block", () => {
  const newer = "docs/evidence/2026-10-02-hbar-to-sauce.json";
  const byFile = { ...records(), [newer]: records()[HBAR_TO_SAUCE] };
  const findings = inspect([...BLOCK, "", `See \`${HBAR_TO_SAUCE}\`.`], byFile, [...TRACKED, newer]);
  assert.deepEqual(
    findings.map(finding => [finding.line, finding.message]),
    [
      [4, `names ${HBAR_TO_SAUCE}, but ${newer} is newer: quote the newest record of each scenario`],
      [15, `names ${HBAR_TO_SAUCE}, but ${newer} is newer: quote the newest record of each scenario`],
    ],
  );
});

// One life cycle of a position, trimmed to the fields the block renders: the fresh-account cycle of 23 Sept 2026.
const CYCLE = "docs/evidence/2026-09-23-position-cycle-362.json";

/** @returns {import("../check-evidence.mjs").EvidenceRecord} */
function cycle() {
  /**
   * @param {import("../check-evidence.mjs").EvidenceTransaction["role"]} role
   * @param {number} gasUsed
   * @param {string} feeTinybar
   * @param {string} previewFeeTinybar
   */
  const sent = (role, gasUsed, feeTinybar, previewFeeTinybar) => ({
    role,
    result: "SUCCESS",
    gasUsed,
    feeTinybar,
    previewFeeTinybar,
    senderNetTinybar: `-${feeTinybar}`,
  });
  return {
    recordedAt: "2026-09-23T08:37:29.229Z",
    software: { viem: "2.39.0", relay: "relay/0.78.5" },
    position: {
      tokenId: "362",
      depositedHbar: "11000000",
      hbarReceivedTinybar: "10999999",
      mintFeeTinybar: "64079561",
    },
    transactions: [
      sent("approve", 726_816, "79222944", "89212980"),
      sent("mint", 761_531, "83006879", "114000000"),
      sent("decrease", 170_067, "18537303", "23265234"),
      sent("collect", 888_485, "96844865", "107571312"),
      sent("nft-approve", 726_792, "79220328", "89210244"),
      sent("burn", 77_921, "8493389", "9713598"),
    ],
  };
}

const CYCLE_BLOCK = [
  "<!-- checks:evidence -->",
  "What a whole life cycle of a liquidity position cost, measured on 23 Sept 2026 through relay/0.78.5 with viem " +
    `2.39.0 (\`${CYCLE}\`):`,
  "",
  "| transaction | network fee | cost preview shown before signing | gas used |",
  "| --- | --- | --- | --- |",
  "| approve the position manager for the token the position deposits | 0.79222944 HBAR | up to 0.8921298 HBAR | 726,816 |",
  "| mint position 362 | 0.83006879 HBAR | up to 1.14 HBAR | 761,531 |",
  "| take position 362's liquidity out | 0.18537303 HBAR | up to 0.23265234 HBAR | 170,067 |",
  "| collect position 362 as native HBAR | 0.96844865 HBAR | up to 1.07571312 HBAR | 888,485 |",
  "| approve the position NFT, without which the burn reverts | 0.79220328 HBAR | up to 0.89210244 HBAR | 726,792 |",
  "| burn position 362 | 0.08493389 HBAR | up to 0.09713598 HBAR | 77,921 |",
  "",
  "Position 362 deposited 0.11 HBAR, was paid 0.10999999 HBAR back natively, and cost 0.64079561 HBAR of mint fee " +
    "and 3.65325708 HBAR of network fees.",
  "<!-- /checks:evidence -->",
];

test("a position record renders as a life cycle, one row per call, and its figures are checked like a swap's", () => {
  const tracked = [...TRACKED, CYCLE];
  const byFile = { ...records(), [CYCLE]: cycle() };
  assert.deepEqual(inspect(CYCLE_BLOCK, byFile, tracked), []);

  const edited = CYCLE_BLOCK.map(line => line.replace("| 0.96844865 HBAR |", "| 1.96844865 HBAR |"));
  const findings = inspect(edited, byFile, tracked);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /the files give: \| collect position 362 as native HBAR \| 0\.96844865 HBAR \|/);
});

test("a block that mixes a life cycle with a swap is refused, because the two are measured differently", () => {
  const { lines, problems } = renderEvidenceBlock([
    { file: CYCLE, record: cycle() },
    { file: HBAR_TO_SAUCE, record: records()[HBAR_TO_SAUCE] },
  ]);
  assert.deepEqual(lines, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /mixes 1 position records with 1 swap records/);
});

test("a life cycle with a role no cycle sends is reported rather than rendered as a blank row", () => {
  const record = cycle();
  record.transactions[0].role = "swap";
  const { problems } = renderEvidenceBlock([{ file: CYCLE, record }]);
  assert.deepEqual(problems, [`${CYCLE} holds a transaction with the role swap, which no life cycle sends`]);
});

test("a line added inside the block, a block without files, an untracked file and an open block are refused", () => {
  assert.match(inspect([...BLOCK.slice(0, -1), "Extra.", BLOCK.at(-1) ?? ""])[0].message, /move it out of the block/);
  assert.match(inspect(["<!-- checks:evidence -->", "No file.", "<!-- /checks:evidence -->"])[0].message, /names no/);
  const missing = BLOCK.map(line => line.replace(SAUCE_TO_HBAR, "docs/evidence/2026-09-22-other.json"));
  assert.match(inspect(missing)[0].message, /quotes docs\/evidence\/2026-09-22-other\.json, which is not tracked/);
  assert.match(inspect(BLOCK.slice(0, -1))[0].message, /has no <!-- \/checks:evidence --> after it/);
});
