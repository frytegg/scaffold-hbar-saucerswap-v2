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
          feeTinybar: "79222944",
          previewFeeTinybar: "89212980",
          senderNetTinybar: "-79222944",
        },
        {
          role: "swap",
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

test("a line added inside the block, a block without files, an untracked file and an open block are refused", () => {
  assert.match(inspect([...BLOCK.slice(0, -1), "Extra.", BLOCK.at(-1) ?? ""])[0].message, /move it out of the block/);
  assert.match(inspect(["<!-- checks:evidence -->", "No file.", "<!-- /checks:evidence -->"])[0].message, /names no/);
  const missing = BLOCK.map(line => line.replace(SAUCE_TO_HBAR, "docs/evidence/2026-09-22-other.json"));
  assert.match(inspect(missing)[0].message, /quotes docs\/evidence\/2026-09-22-other\.json, which is not tracked/);
  assert.match(inspect(BLOCK.slice(0, -1))[0].message, /has no <!-- \/checks:evidence --> after it/);
});
