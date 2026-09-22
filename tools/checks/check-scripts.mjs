// @ts-check
import { existsSync } from "node:fs";
import path from "node:path";
import { codeLines, parseMarkdown } from "./lib/markdown.mjs";
import { findScriptCommands, isSharedBuiltin } from "./lib/package-manager.mjs";
import { isMainModule, resultFrom, runCli } from "./lib/report.mjs";
import { listDocs, listTrackedFiles, readJson, readRootScripts, readText } from "./lib/repo.mjs";

const MANIFEST = "template.json";
/** A placeholder and the words after it, up to the next shell separator or placeholder. */
const INVOCATION = /\{run:([^{}]+)\}((?:[ \t]+[^\s&|;{]+)*)/g;
const FLAG = /^-{1,2}[A-Za-z]/;

/**
 * @typedef {object} DocCommands
 * @property {import("./lib/report.mjs").Finding[]} findings
 * @property {Map<string, string>} shownWithArguments script name to the place a doc passes it an argument
 */

/**
 * @param {import("./lib/markdown.mjs").MarkdownDoc} doc
 * @param {Set<string>} rootScripts
 * @param {(dir: string) => Set<string> | undefined} [scriptsIn] the scripts of the package in a directory of the
 * repository, for `npm run … --prefix <dir>`; undefined when that directory holds no tracked `package.json`
 * @returns {DocCommands}
 */
export function inspectDocCommands(doc, rootScripts, scriptsIn = () => undefined) {
  /** @type {DocCommands} */
  const result = { findings: [], shownWithArguments: new Map() };
  for (const { line, text } of codeLines(doc)) {
    for (const command of findScriptCommands(text)) {
      if (isSharedBuiltin(command)) continue;
      /** @param {string} message */
      const report = message => result.findings.push({ file: doc.file, line, message });
      const shown = [command.script, ...command.flags, ...command.positionals].join(" ");
      const scripts = command.packageDir === undefined ? rootScripts : scriptsIn(command.packageDir);
      const owner = command.packageDir === undefined ? "a root" : `a ${command.packageDir}`;
      if (scripts === undefined) {
        report(`"${command.packageDir}" holds no tracked package.json for "${command.script}" to run in`);
      } else if (!scripts.has(command.script)) {
        report(`"${command.script}" is not ${owner} script`);
      } else if (command.flags.length > 0) {
        report(`"${shown}" carries a flag, which npm-mode drops: document a flag-free alias script`);
      } else if (command.positionals.length > 0 && command.packageDir === undefined) {
        result.shownWithArguments.set(command.script, `${doc.file}:${line}`);
      }
    }
  }
  return result;
}

/**
 * @param {unknown} value
 * @param {string} at
 * @returns {{ at: string, text: string }[]} every string of a JSON value with the path that leads to it
 */
function stringLeaves(value, at = "") {
  if (typeof value === "string") return [{ at, text: value }];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    stringLeaves(child, Array.isArray(value) ? `${at}[${key}]` : at ? `${at}.${key}` : key),
  );
}

/**
 * @param {object} input
 * @param {any} input.manifest parsed `template.json`
 * @param {Set<string>} input.rootScripts
 * @param {Map<string, string>} input.shownWithArguments
 * @returns {import("./lib/report.mjs").Finding[]}
 */
export function inspectManifest({ manifest, rootScripts, shownWithArguments }) {
  /** @type {string[]} */
  const declared = manifest["create-scaffold-hbar"]?.capabilities?.solidityFramework ?? [];
  const frameworks = declared.filter(framework => framework !== "none");
  /** @type {import("./lib/report.mjs").Finding[]} */
  const findings = [];
  /** @param {string} message */
  const report = message => findings.push({ file: MANIFEST, message });

  for (const { at, text } of stringLeaves(manifest)) {
    for (const [, name, tail] of text.matchAll(INVOCATION)) {
      const words = tail.split(/[ \t]+/).filter(Boolean);
      // In npm-mode the placeholder becomes `npm run <script>`, and the package manager keeps a flag that follows.
      const flag = words.find(word => FLAG.test(word));
      if (flag) report(`${at}: "${flag}" follows {run:${name}} and never reaches the script in npm-mode: use an alias`);

      const scripts = name.startsWith("framework:")
        ? frameworks.map(framework => name.replace("framework", framework))
        : [name];
      for (const script of scripts) {
        if (!rootScripts.has(script)) {
          report(`${at}: {run:${name}} needs the root script "${script}"`);
        } else if (at.endsWith(".command") && words.length === 0 && shownWithArguments.has(script)) {
          report(`${at}: runs "${script}" bare, ${shownWithArguments.get(script)} passes it an argument`);
        }
      }
    }
  }
  return findings;
}

/** @type {import("./lib/report.mjs").Check} */
export const check = {
  name: "check-scripts",
  run({ repoRoot }) {
    const rootScripts = readRootScripts(repoRoot);
    const tracked = listTrackedFiles(repoRoot);
    /** @param {string} dir */
    const scriptsIn = dir => {
      const manifest = path.posix.join(path.posix.normalize(dir), "package.json");
      if (!tracked.includes(manifest)) return undefined;
      return new Set(Object.keys(readJson(repoRoot, manifest).scripts ?? {}));
    };
    const docs = listDocs(tracked).map(file => parseMarkdown(file, readText(repoRoot, file)));
    const inspected = docs.map(doc => inspectDocCommands(doc, rootScripts, scriptsIn));
    const findings = inspected.flatMap(result => result.findings);
    const shownWithArguments = new Map(inspected.flatMap(result => [...result.shownWithArguments]));

    const hasManifest = existsSync(path.join(repoRoot, MANIFEST));
    if (hasManifest) {
      findings.push(...inspectManifest({ manifest: readJson(repoRoot, MANIFEST), rootScripts, shownWithArguments }));
    }
    const scope = hasManifest
      ? `${docs.length} docs and ${MANIFEST}`
      : `${docs.length} docs (no ${MANIFEST}: a scaffold)`;
    return resultFrom(findings, `${rootScripts.size} root scripts against ${scope}`);
  },
};

if (isMainModule(import.meta.url)) await runCli(check);
