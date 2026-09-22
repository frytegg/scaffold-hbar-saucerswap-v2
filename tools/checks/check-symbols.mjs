// @ts-check
import path from "node:path";
import { createAllowlist, parseMarkdown } from "./lib/markdown.mjs";
import { isMainModule, resultFrom, runCli } from "./lib/report.mjs";
import { listDocs, listSourceFiles, listTrackedFiles, listWorkspaceDirs, readJson, readText } from "./lib/repo.mjs";
import { listModuleExports, loadWorkspace } from "./lib/typescript.mjs";

const IDENTIFIER = /(?<![\w$-])[A-Za-z_$][\w$]{2,}(?![\w$-])/g;

/** Names of naming conventions, as a style guide writes them: spelled like code, never declared by it. */
const CASE_STYLES = new Set([
  "camelCase",
  "lowerCamelCase",
  "PascalCase",
  "UpperCamelCase",
  "CONSTANT_CASE",
  "SCREAMING_SNAKE_CASE",
  "UPPER_SNAKE_CASE",
]);

/**
 * @typedef {object} Dependencies
 * @property {(name: string) => boolean} has true when a workspace declares this package
 * @property {(name: string) => Set<string> | undefined} exportsOf undefined when its types cannot be resolved
 */

/**
 * @param {string} word
 * @returns {boolean} true for mixed-case and upper-snake-case words: spellings that only code uses
 */
function looksLikeCode(word) {
  const mixedCase = /[a-z]/.test(word) && /[A-Z]/.test(word);
  return mixedCase || /^_*[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(word);
}

/**
 * @param {string} span the text of an inline code span
 * @returns {string[]}
 */
export function identifiersIn(span) {
  if (span.includes("/")) return [];
  return [...span.replace(/0x[0-9a-fA-F]+/g, " ").matchAll(IDENTIFIER)]
    .map(match => match[0])
    .filter(word => looksLikeCode(word) && !CASE_STYLES.has(word));
}

/**
 * A name passes when the tracked source contains it, or when a package named on the same line exports it.
 * @param {object} input
 * @param {import("./lib/markdown.mjs").MarkdownDoc} input.doc
 * @param {(word: string) => boolean} input.inSource
 * @param {Dependencies} input.dependencies
 * @returns {import("./lib/report.mjs").Finding[]}
 */
export function findSymbolFindings({ doc, inSource, dependencies }) {
  const allowlist = createAllowlist(doc, "symbols");
  /** @type {import("./lib/report.mjs").Finding[]} */
  const findings = [];
  /** @type {Set<string>} */
  const reported = new Set();

  for (const span of doc.spans) {
    for (const word of identifiersIn(span.text)) {
      if (reported.has(word) || allowlist.permits(word) || inSource(word)) continue;
      const packages = doc.spans.filter(other => other.line === span.line && dependencies.has(other.text));
      const verdicts = packages.map(({ text: name }) => ({ name, exports: dependencies.exportsOf(name) }));
      if (verdicts.some(verdict => verdict.exports?.has(word))) continue;
      reported.add(word);
      const detail = verdicts.map(({ name, exports }) =>
        exports ? `${name} does not export it` : `the types of ${name} cannot be resolved (is it installed?)`,
      );
      const message = [`\`${word}\` is not in the tracked source`, ...detail].join("; ");
      findings.push({ file: doc.file, line: span.line, message });
    }
  }
  return [...findings, ...allowlist.staleEntries()];
}

/**
 * @param {string} repoRoot
 * @param {string[]} tracked
 * @returns {Dependencies} export lists come from the compiler, resolved on first use
 */
function workspaceDependencies(repoRoot, tracked) {
  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const dir of listWorkspaceDirs(tracked)) {
    const manifest = readJson(repoRoot, `${dir}/package.json`);
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (!owner.has(name)) owner.set(name, dir);
    }
  }
  /** @type {Map<string, import("./lib/typescript.mjs").Workspace>} */
  const workspaces = new Map();
  /** @type {Map<string, Set<string> | undefined>} */
  const cache = new Map();

  return {
    has: name => owner.has(name),
    exportsOf(name) {
      const dir = owner.get(name);
      if (dir === undefined) return undefined;
      if (!cache.has(name)) {
        const workspace = workspaces.get(dir) ?? loadWorkspace(path.resolve(repoRoot, dir));
        workspaces.set(dir, workspace);
        cache.set(name, listModuleExports(workspace, name));
      }
      return cache.get(name);
    },
  };
}

/** @type {import("./lib/report.mjs").Check} */
export const check = {
  name: "check-symbols",
  run({ repoRoot }) {
    const tracked = listTrackedFiles(repoRoot);
    const source = listSourceFiles(tracked)
      .map(file => readText(repoRoot, file))
      .join("\n");
    /** @param {string} word */
    const inSource = word => new RegExp(`(?<![\\w$])${word.replace(/\$/g, "\\$")}(?![\\w$])`).test(source);

    const docs = listDocs(tracked).map(file => parseMarkdown(file, readText(repoRoot, file)));
    const dependencies = workspaceDependencies(repoRoot, tracked);
    const findings = docs.flatMap(doc => findSymbolFindings({ doc, inSource, dependencies }));
    const named = new Set(docs.flatMap(doc => doc.spans.flatMap(span => identifiersIn(span.text))));
    return resultFrom(findings, `${named.size} identifiers in ${docs.length} docs`);
  },
};

if (isMainModule(import.meta.url)) await runCli(check);
