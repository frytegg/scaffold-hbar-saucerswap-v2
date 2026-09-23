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
    return resultFrom(
      findings,
      `${sections.length} behaviours and ${screenshots} screenshots in ${TRAP_DOC}, against ${suites.length} test files`,
    );
  },
};

if (isMainModule(import.meta.url)) await runCli(check);
