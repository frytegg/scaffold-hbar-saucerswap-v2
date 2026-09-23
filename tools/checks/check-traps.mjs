// @ts-check
import { parseMarkdown } from "./lib/markdown.mjs";
import { isMainModule, resultFrom, runCli, skipped } from "./lib/report.mjs";
import { isHostKit, listTrackedFiles, readText } from "./lib/repo.mjs";

/** @typedef {import("./lib/report.mjs").Finding} Finding */
/** @typedef {import("./lib/markdown.mjs").MarkdownDoc} MarkdownDoc */
/** @typedef {{ name: string, line: number, lines: string[] }} Part */
/** @typedef {{ line: number, target: string, caption: string, captionLine: number }} Screenshot */
/** @typedef {{ title: string, line: number, parts: Part[], screenshots: Screenshot[] }} Section */

/** The document whose shape this check enforces. Absent from a scaffold that dropped it: then there is nothing to judge. */
export const TRAP_DOC = "docs/hedera-behaviour.md";

/**
 * The page that answers the same behaviours for a caller outside this repository. Its table says it holds one row
 * per section of `TRAP_DOC`, in the file's own order, and a reorder of either file is one commit away from making
 * that false. Absent from a scaffold that dropped it, as `TRAP_DOC` can be.
 */
export const CALLER_DOC = "docs/use-the-checks-in-your-app.md";

/** The header cell that names the column of behaviours, which is what ties that table to `TRAP_DOC`. */
const BEHAVIOUR_COLUMN = "behaviour";

const DELIMITER_CELL = /^:?-{3,}:?$/;

/** The six parts of `DOCS-PLAN.md`, in the order a reader meets them. */
export const PARTS = [
  "Symptom",
  "Real cause",
  "Proof",
  "What it costs",
  "How the template protects",
  "The test that keeps it fixed",
];

const PART_OPENER = /^\*\*([^*]+)\*\*/;
const PROOF_LINK =
  /\]\(https:\/\/(?:[a-z0-9-]+\.mirrornode\.hedera\.com\/api\/v1\/contracts\/results\/|hashscan\.io\/[a-z0-9-]+\/tx\/)0x[0-9a-fA-F]{64}\)/;
const IMAGE = /^!\[[^\]]*\]\(\s*([^\s)]+)/;
/** A quoted phrase long enough to be a test name; a shorter one is a word, not a title. */
const QUOTED = /"([^"]{8,})"/g;
const TEST_DECLARATION = /(?:^|[^\w$.])(?:it|test|describe|suite)(?:\.\w+)*\s*\(\s*$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$|(^|\/)test\/.+\.[cm]?[jt]sx?$/;

/** A screenshot is an illustration of something verifiable, so its caption says what was running and when. */
const WALLETS = ["MetaMask", "HashPack", "Blade", "Kabila"];
const BROWSERS = ["Chrome", "Firefox", "Edge", "Brave", "Safari"];
const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Sept|Sep|Oct|Nov|Dec";
const DATE = new RegExp(`\\b\\d{1,2} (?:${MONTHS}) \\d{4}\\b`);

/**
 * @param {string[]} names
 * @returns {RegExp} matches any of them followed by a version, as a caption writes it: "MetaMask 13.48.0", "Chrome 152"
 */
function versionOf(names) {
  return new RegExp(`\\b(?:${names.join("|")})\\s+\\d+(?:\\.\\d+)*\\b`);
}

/**
 * @param {MarkdownDoc} doc
 * @returns {Section[]} one per `##` heading, with the parts and screenshots it holds
 */
export function splitSections(doc) {
  const outsideFences = new Set(doc.prose.map(({ line }) => line));
  const headings = doc.headings.filter(heading => heading.level === 2);
  return headings.map((heading, index) => {
    const next = doc.headings.find(other => other.line > heading.line && other.level <= 2);
    const to = next ? next.line - 1 : doc.lines.length;
    /** @type {Part[]} */
    const parts = [];
    /** @type {Screenshot[]} */
    const screenshots = [];
    for (let line = heading.line + 1; line <= to; line += 1) {
      const text = doc.lines[line - 1];
      if (!outsideFences.has(line)) continue;
      const opener = PART_OPENER.exec(text);
      if (opener) parts.push({ name: opener[1].trim(), line, lines: [] });
      const image = IMAGE.exec(text);
      if (image) screenshots.push({ line, target: image[1], ...captionAfter(doc, line, to) });
    }
    parts.forEach((part, position) => {
      const end = position + 1 < parts.length ? parts[position + 1].line - 1 : to;
      part.lines = doc.lines.slice(part.line - 1, end);
    });
    return { title: headings[index].title, line: heading.line, parts, screenshots };
  });
}

/**
 * @param {MarkdownDoc} doc
 * @param {number} imageLine
 * @param {number} to last line of the section
 * @returns {{ caption: string, captionLine: number }} the italic line under the image; "" when the image has none
 */
function captionAfter(doc, imageLine, to) {
  for (let line = imageLine + 1; line <= to; line += 1) {
    const text = doc.lines[line - 1].trim();
    if (text === "") continue;
    return /^\*[^*].*\*$/.test(text) ? { caption: text, captionLine: line } : { caption: "", captionLine: line };
  }
  return { caption: "", captionLine: imageLine };
}

/**
 * @param {string} corpus every committed test file, concatenated
 * @param {string} title
 * @returns {boolean} true when a test declaration takes exactly this title
 */
export function declaresTest(corpus, title) {
  const quoted = `"${title}"`;
  for (let from = corpus.indexOf(quoted); from !== -1; from = corpus.indexOf(quoted, from + 1)) {
    if (TEST_DECLARATION.test(corpus.slice(Math.max(0, from - 64), from))) return true;
  }
  return false;
}

/**
 * @param {Section} section
 * @param {string} file
 * @returns {Finding[]} the six parts, once each, in order
 */
function inspectParts(section, file) {
  /** @type {Finding[]} */
  const findings = [];
  const unknown = section.parts.filter(part => !PARTS.includes(part.name));
  for (const part of unknown) {
    findings.push({ file, line: part.line, message: `"${part.name}" is not one of the six parts of a behaviour` });
  }
  const named = section.parts.map(part => part.name).filter(name => PARTS.includes(name));
  for (const expected of PARTS) {
    if (!named.includes(expected)) {
      findings.push({ file, line: section.line, message: `this section has no "${expected}" part` });
    }
  }
  const inOrder = PARTS.filter(part => named.includes(part));
  if (named.length !== inOrder.length || named.some((name, index) => name !== inOrder[index])) {
    findings.push({
      file,
      line: section.line,
      message: `the parts read ${named.join(", ")}: they come once each, in the order ${PARTS.join(", ")}`,
    });
  }
  return findings;
}

/**
 * @param {Section} section
 * @param {string} file
 * @param {(title: string) => boolean} isDeclared
 * @returns {Finding[]}
 */
function inspectProofAndTests(section, file, isDeclared) {
  /** @type {Finding[]} */
  const findings = [];
  const proof = section.parts.find(part => part.name === "Proof");
  if (proof && !PROOF_LINK.test(proof.lines.join("\n"))) {
    findings.push({ file, line: proof.line, message: "the Proof part links to no transaction on chain" });
  }
  const last = section.parts.find(part => part.name === PARTS[PARTS.length - 1]);
  if (!last) return findings;
  const titles = [...last.lines.join("\n").matchAll(QUOTED)].map(match => match[1]);
  const declared = titles.filter(isDeclared);
  if (declared.length === 0) {
    findings.push({
      file,
      line: last.line,
      message: `"${PARTS[PARTS.length - 1]}" names no test that a committed test file declares`,
    });
  }
  for (const title of titles.filter(title => !declared.includes(title))) {
    findings.push({
      file,
      line: last.line,
      message: `no test is declared with the title "${title}": name a test that exists, or drop the quotation marks`,
    });
  }
  return findings;
}

/**
 * @param {Section} section
 * @param {string} file
 * @returns {Finding[]} a picture is worth nothing without the versions and the day it was taken
 */
function inspectScreenshots(section, file) {
  const wallet = versionOf(WALLETS);
  const browser = versionOf(BROWSERS);
  return section.screenshots.flatMap(screenshot => {
    if (screenshot.caption === "") {
      return [{ file, line: screenshot.line, message: `${screenshot.target} has no italic caption under it` }];
    }
    const missing = [
      wallet.test(screenshot.caption) ? "" : "the wallet and its version",
      browser.test(screenshot.caption) ? "" : "the browser and its version",
      DATE.test(screenshot.caption) ? "" : "the date it was taken",
    ].filter(Boolean);
    return missing.length === 0
      ? []
      : [{ file, line: screenshot.captionLine, message: `this caption names neither ${missing.join(" nor ")}` }];
  });
}

/**
 * The rows of the table whose first column is the behaviours. Cells are read from the raw line: `prose` blanks
 * inline code out, and a heading can carry some.
 * @param {MarkdownDoc} doc
 * @returns {{ line: number, behaviour: string }[]} empty when the doc holds no such table
 */
export function behaviourRows(doc) {
  const outsideFences = new Set(doc.prose.map(({ line }) => line));
  /** @type {{ line: number, behaviour: string }[]} */
  const rows = [];
  /** `header` before a table, `other` inside one this check does not read, then its delimiter row, then its rows. */
  let state = "header";
  doc.lines.forEach((content, index) => {
    const line = index + 1;
    const text = content.trim();
    if (!outsideFences.has(line) || !text.startsWith("|")) {
      state = "header";
      return;
    }
    const cell = text.split("|")[1]?.trim() ?? "";
    if (state === "header") state = cell.toLowerCase() === BEHAVIOUR_COLUMN ? "delimiter" : "other";
    else if (state === "delimiter") state = DELIMITER_CELL.test(cell) ? "rows" : "other";
    else if (state === "rows") rows.push({ line, behaviour: cell });
  });
  return rows;
}

/**
 * @param {string} title a `##` heading of `TRAP_DOC`
 * @param {string} cell the table cell that names it
 * @returns {boolean} true when the cell is that heading, in lower case and cut short at the end as a link text is
 */
function names(title, cell) {
  return cell !== "" && title.toLowerCase().startsWith(cell.toLowerCase());
}

/**
 * @param {Section[]} sections of `TRAP_DOC`
 * @param {{ line: number, behaviour: string }[]} rows of the caller page's table
 * @param {string} file the caller page
 * @returns {Finding[]} what holds that page's "one section per row and in this order" to the file it points at
 */
export function inspectCallerTable(sections, rows, file) {
  /** @type {Finding[]} */
  const findings = [];
  if (rows.length !== sections.length) {
    findings.push({
      file,
      line: rows[0]?.line,
      message: `one row per section of ${TRAP_DOC}: ${sections.length} sections, ${rows.length} rows`,
    });
  }
  rows.forEach((row, index) => {
    const section = sections[index];
    if (section === undefined || names(section.title, row.behaviour)) return;
    findings.push({
      file,
      line: row.line,
      message: `row ${index + 1} is "${row.behaviour}" and section ${index + 1} of ${TRAP_DOC} is "${section.title}"`,
    });
  });
  return findings;
}

/**
 * @param {MarkdownDoc} doc
 * @param {(title: string) => boolean} isDeclared
 * @returns {Finding[]}
 */
export function findTrapFindings(doc, isDeclared) {
  return splitSections(doc).flatMap(section => [
    ...inspectParts(section, doc.file),
    ...inspectProofAndTests(section, doc.file, isDeclared),
    ...inspectScreenshots(section, doc.file),
  ]);
}

/** @type {import("./lib/report.mjs").Check} */
export const check = {
  name: "check-traps",
  run({ repoRoot }) {
    const tracked = listTrackedFiles(repoRoot);
    if (!tracked.includes(TRAP_DOC)) return skipped(`${TRAP_DOC} is not in the repository`);
    const suites = tracked.filter(file => !isHostKit(file) && TEST_FILE.test(file));
    const corpus = suites.map(file => readText(repoRoot, file)).join("\n");
    const doc = parseMarkdown(TRAP_DOC, readText(repoRoot, TRAP_DOC));
    const findings = findTrapFindings(doc, title => declaresTest(corpus, title));
    const sections = splitSections(doc);
    const screenshots = sections.reduce((total, section) => total + section.screenshots.length, 0);

    const hasCaller = tracked.includes(CALLER_DOC);
    const rows = hasCaller ? behaviourRows(parseMarkdown(CALLER_DOC, readText(repoRoot, CALLER_DOC))) : [];
    if (hasCaller) findings.push(...inspectCallerTable(sections, rows, CALLER_DOC));

    const against = hasCaller
      ? `${suites.length} test files and ${rows.length} rows of ${CALLER_DOC}`
      : `${suites.length} test files`;
    return resultFrom(
      findings,
      `${sections.length} behaviours and ${screenshots} screenshots in ${TRAP_DOC}, against ${against}`,
    );
  },
};

if (isMainModule(import.meta.url)) await runCli(check);
