// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  behaviourRows,
  CALLER_DOC,
  declaresTest,
  findTrapFindings,
  inspectCallerTable,
  PARTS,
  splitSections,
} from "../check-traps.mjs";
import { parseMarkdown } from "../lib/markdown.mjs";
import { fixtureDoc, linesOf } from "./support.mjs";

const DOC = "docs/hedera-behaviour.md";
const DECLARED = ["a test that exists"];

/** The second one is longer than the row that names it, as a heading shortened into a link text is. */
const BEHAVIOURS = ["The first behaviour", "The second behaviour, and who it bites"];

/**
 * @param {string[]} rows first-column cells, as the caller page writes them
 * @returns {import("../lib/markdown.mjs").MarkdownDoc}
 */
function callerTable(rows) {
  const lines = ["| behaviour | the call |", "| --- | --- |", ...rows.map(row => `| ${row} | \`call()\` |`)];
  return parseMarkdown(CALLER_DOC, lines.join("\n"));
}

/**
 * @param {string[]} titles
 * @returns {ReturnType<typeof splitSections>}
 */
function trapSections(titles) {
  return splitSections(parseMarkdown(DOC, titles.map(title => `## ${title}\n`).join("\n")));
}

/**
 * @param {string[]} rows
 * @param {string[]} [titles]
 * @returns {string[]}
 */
function tableFindings(rows, titles = BEHAVIOURS) {
  return inspectCallerTable(trapSections(titles), behaviourRows(callerTable(rows)), CALLER_DOC).map(
    finding => finding.message,
  );
}

/** @param {import("../lib/markdown.mjs").MarkdownDoc} doc */
function check(doc) {
  return findTrapFindings(doc, title => DECLARED.includes(title));
}

test("a behaviour with the six parts, a proof link, a real test and a full caption passes", () => {
  assert.deepEqual(check(fixtureDoc("traps-clean.markdown", DOC)), []);
});

test("the negative fixture fails, one finding per defect", () => {
  const findings = check(fixtureDoc("traps-broken.markdown", DOC));
  assert.deepEqual(
    findings.map(finding => finding.message),
    [
      'this section has no "How the template protects" part',
      "the Proof part links to no transaction on chain",
      '"The test that keeps it fixed" names no test that a committed test file declares',
      'no test is declared with the title "a test nobody ever wrote": name a test that exists, or drop the ' +
        "quotation marks",
      "this caption names neither the wallet and its version nor the browser and its version nor the date it was taken",
      "the parts read Symptom, Proof, Real cause, What it costs, How the template protects, The test that keeps it " +
        `fixed: they come once each, in the order ${PARTS.join(", ")}`,
    ],
  );
});

test("a part the six do not name is refused, so the format cannot grow a seventh", () => {
  const findings = check(parseMarkdown(DOC, "## A behaviour\n\n**Note** — an aside."));
  assert.equal(
    findings.some(finding => finding.message === '"Note" is not one of the six parts of a behaviour'),
    true,
  );
});

test("a title is a test only where a test declaration takes it", () => {
  assert.equal(declaresTest('  it("a test that exists", () => {', "a test that exists"), true);
  assert.equal(declaresTest('  it(\n    "a test that exists",', "a test that exists"), true);
  assert.equal(declaresTest('  it.skip("a test that exists", () => {', "a test that exists"), true);
  assert.equal(declaresTest('// see "a test that exists" above', "a test that exists"), false);
  assert.equal(declaresTest('const label = "a test that exists";', "a test that exists"), false);
});

test("a section is split at its own parts, and each part keeps the lines under it", () => {
  const [section] = splitSections(fixtureDoc("traps-clean.markdown", DOC));
  assert.deepEqual(
    section.parts.map(part => part.name),
    PARTS,
  );
  assert.equal(section.screenshots.length, 1);
  assert.match(section.screenshots[0].caption, /MetaMask 13\.48\.0 on Chrome 152/);
});

test("a caption that names a version but no date is still refused", () => {
  const doc = parseMarkdown(DOC, "## A behaviour\n\n![a wallet](images/x.png)\n\n*MetaMask 13.48.0 on Chrome 152.*");
  const caption = check(doc).filter(finding => finding.message.startsWith("this caption"));
  assert.deepEqual(
    caption.map(finding => finding.message),
    ["this caption names neither the date it was taken"],
  );
  assert.deepEqual(linesOf(caption), [5]);
});

test("an image with no caption under it is refused at the image", () => {
  const doc = parseMarkdown(DOC, "## A behaviour\n\n![a wallet](images/x.png)\n\nOrdinary prose.");
  const image = check(doc).filter(finding => finding.message.includes("italic caption"));
  assert.deepEqual(
    image.map(finding => finding.message),
    ["images/x.png has no italic caption under it"],
  );
});

test("one row per behaviour, in the file's order, passes", () => {
  assert.deepEqual(tableFindings(["the first behaviour", "the second behaviour"]), []);
});

test("two rows swapped are refused, which reordering either file would do", () => {
  assert.deepEqual(tableFindings(["the second behaviour", "the first behaviour"]), [
    `row 1 is "the second behaviour" and section 1 of ${DOC} is "The first behaviour"`,
    `row 2 is "the first behaviour" and section 2 of ${DOC} is "The second behaviour, and who it bites"`,
  ]);
});

test("a behaviour with no row of its own is refused", () => {
  assert.deepEqual(tableFindings(["the first behaviour"]), [`one row per section of ${DOC}: 2 sections, 1 rows`]);
});

test("a row that is longer than the heading it names is refused, not shortened the other way", () => {
  assert.deepEqual(tableFindings(["the first behaviour, and who it bites", "the second behaviour"]), [
    `row 1 is "the first behaviour, and who it bites" and section 1 of ${DOC} is "The first behaviour"`,
  ]);
});

test("a table whose first column is something else is not read as behaviours", () => {
  const doc = parseMarkdown(CALLER_DOC, "| command | what it proves |\n| --- | --- |\n| replay | the failures |");
  assert.deepEqual(behaviourRows(doc), []);
});

test("a table inside a fenced block is an example, not the page's own", () => {
  const doc = parseMarkdown(CALLER_DOC, "```md\n| behaviour | the call |\n| --- | --- |\n| a row | x |\n```");
  assert.deepEqual(behaviourRows(doc), []);
});

test("a part in a fenced block is a snippet, not a part of the behaviour", () => {
  const body = [
    "## A behaviour",
    "",
    ...PARTS.map(part => `**${part}** — [t](https://hashscan.io/testnet/tx/0x${"a".repeat(64)}) "a test that exists".`),
    "",
    "```md",
    "**Symptom** — how the format is written.",
    "```",
  ].join("\n");
  assert.deepEqual(check(parseMarkdown(DOC, body)), []);
});
