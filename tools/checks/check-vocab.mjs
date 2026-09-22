// @ts-check
import { existsSync } from "node:fs";
import path from "node:path";
import { codeLines, parseMarkdown } from "./lib/markdown.mjs";
import { EXACT_COMMAND, YARN_WORD } from "./lib/package-manager.mjs";
import { isMainModule, resultFrom, runCli } from "./lib/report.mjs";
import { listDocs, listTrackedFiles, readText } from "./lib/repo.mjs";

const MANIFEST = "template.json";

/** Wording the Hedera docs avoid, with what they write instead. */
const AVOIDED = [
  { pattern: /\bblockchain\b/i, instead: 'the Hedera docs do not use the word: write "network" or "ledger"' },
  { pattern: /\bHbar\b/, instead: 'the currency is written "HBAR"' },
  { pattern: /\bHBARs\b/, instead: '"HBAR" takes no plural' },
  { pattern: /\bEVM alias\b/i, instead: 'the docs say "EVM address"' },
  { pattern: /@hashgraph\/sdk\b/, instead: "the SDK is published as @hiero-ledger/sdk" },
];

const BARE_NAME = "a package manager is named outside an exact script command, and npm-mode scaffolds rewrite the word";

/**
 * @param {string} file
 * @param {import("./lib/markdown.mjs").LineText[]} lines
 * @returns {import("./lib/report.mjs").Finding[]}
 */
function avoidedWording(file, lines) {
  return lines.flatMap(({ line, text }) =>
    AVOIDED.filter(({ pattern }) => pattern.test(text)).map(({ pattern, instead }) => ({
      file,
      line,
      message: `"${pattern.exec(text)?.[0]}": ${instead}`,
    })),
  );
}

/**
 * @param {import("./lib/markdown.mjs").MarkdownDoc} doc
 * @returns {import("./lib/report.mjs").Finding[]}
 */
export function inspectDocWording(doc) {
  const everyLine = doc.lines.map((text, index) => ({ line: index + 1, text }));
  const inProse = doc.prose.filter(({ text }) => YARN_WORD.test(text));
  const inCode = codeLines(doc).filter(({ text }) => YARN_WORD.test(text) && !EXACT_COMMAND.test(text));
  const lines = new Set([...inProse, ...inCode].map(({ line }) => line));
  return [
    ...avoidedWording(doc.file, everyLine),
    ...[...lines].map(line => ({ file: doc.file, line, message: BARE_NAME })),
  ];
}

/**
 * The manifest's texts reach the developer through the CLI's closing message and the generated `.env.example`.
 * @param {string} text raw `template.json`
 * @returns {import("./lib/report.mjs").Finding[]}
 */
export function inspectManifestWording(text) {
  const lines = text.split(/\r?\n/).map((content, index) => ({ line: index + 1, text: content }));
  const proseLines = lines.filter(({ text: content }) => !/^\s*"packageManager":/.test(content));
  return [
    ...avoidedWording(MANIFEST, lines),
    ...proseLines
      .filter(({ text: content }) => YARN_WORD.test(content))
      .map(({ line }) => ({ file: MANIFEST, line, message: `${BARE_NAME}; use a {run:script} placeholder` })),
  ];
}

/** @type {import("./lib/report.mjs").Check} */
export const check = {
  name: "check-vocab",
  run({ repoRoot }) {
    const docs = listDocs(listTrackedFiles(repoRoot)).map(file => parseMarkdown(file, readText(repoRoot, file)));
    const findings = docs.flatMap(inspectDocWording);
    const hasManifest = existsSync(path.join(repoRoot, MANIFEST));
    if (hasManifest) findings.push(...inspectManifestWording(readText(repoRoot, MANIFEST)));
    return resultFrom(findings, `${docs.length} docs${hasManifest ? ` and ${MANIFEST}` : ""}`);
  },
};

if (isMainModule(import.meta.url)) await runCli(check);
