// @ts-check
import { existsSync } from "node:fs";
import path from "node:path";
import { codeLines, createAllowlist, parseMarkdown } from "./lib/markdown.mjs";
import { findScriptCommands, isSharedBuiltin } from "./lib/package-manager.mjs";
import { isMainModule, resultFrom, runCli } from "./lib/report.mjs";
import { listDocs, listTrackedFiles, readJson, readRootScripts, readText } from "./lib/repo.mjs";

const MANIFEST = "template.json";
/** Where a root script nobody names is reported: the file that declares it. */
const ROOT_MANIFEST = "package.json";
/** A placeholder and the words after it, up to the next shell separator or placeholder. */
const INVOCATION = /\{run:([^{}]+)\}((?:[ \t]+[^\s&|;{]+)*)/g;
const FLAG = /^-{1,2}[A-Za-z]/;

/**
 * A root script whose whole job is to reach into a workspace, and whose name is the seam the CLI's npm-mode rewrite
 * forwards a flag through: `lint:strict` runs `next:lint:all --max-warnings=0`, and the alias is machinery rather
 * than a command anyone is meant to find. Every other root script is one a reader should be able to reach.
 */
const WORKSPACE_ALIAS = /^(?:next|hardhat):/;

/**
 * @typedef {object} DocCommands
 * @property {import("./lib/report.mjs").Finding[]} findings
 * @property {Set<string>} named the root scripts this doc names
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
  const result = { findings: [], named: new Set(), shownWithArguments: new Map() };
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
        continue;
      }
      if (!scripts.has(command.script)) {
        report(`"${command.script}" is not ${owner} script`);
        continue;
      }
      if (command.packageDir === undefined) result.named.add(command.script);
      if (command.flags.length > 0) {
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

/**
 * The other direction of this check. Every script a doc names has to exist, and a script that exists has to be
 * named: a command nobody documents is one only a reader of `package.json` will ever run, which is how a working
 * command can ship invisible with every check green.
 * @param {object} input
 * @param {Set<string>} input.rootScripts
 * @param {Set<string>} input.named every root script a doc or the manifest names
 * @param {(script: string) => boolean} input.permits a deliberate exception, declared in a doc's `checks:allow`
 * @returns {import("./lib/report.mjs").Finding[]}
 */
export function inspectUndocumented({ rootScripts, named, permits }) {
  return [...rootScripts]
    .filter(script => !WORKSPACE_ALIAS.test(script) && !named.has(script) && !permits(script))
    .sort()
    .map(script => ({
      file: ROOT_MANIFEST,
      message: `"${script}" is a root script no doc names: document it, or declare it in a checks:allow "scripts" entry`,
    }));
}

/**
 * A scaffold holds fewer root scripts than the repository it came from: the CLI drops the lifecycle ones a scaffolded
 * project has no use for — `postinstall`, `precommit`, `lint-staged`, which exist here for husky. An allowlist entry
 * for one of those excuses nothing there, and reporting it would ask a reader to delete a line that is right in the
 * tree it was written in. So in a scaffold an entry whose script this tree does not have is consumed instead. Where
 * `template.json` is present — this repository — the strict reading stands, and an entry nothing needs is a finding.
 * @param {object} input
 * @param {{ permits: (token: string) => boolean; declared: () => string[] }[]} input.allowlists
 * @param {Set<string>} input.rootScripts
 */
export function consumeEntriesForAbsentScripts({ allowlists, rootScripts }) {
  for (const allowlist of allowlists) {
    for (const script of allowlist.declared()) {
      if (!rootScripts.has(script)) allowlist.permits(script);
    }
  }
}

/**
 * @param {any} manifest parsed `template.json`
 * @returns {string[]} the script each `{run:…}` placeholder of it runs
 */
function manifestScripts(manifest) {
  return stringLeaves(manifest).flatMap(({ text }) => [...text.matchAll(INVOCATION)].map(([, name]) => name));
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
    const named = new Set(inspected.flatMap(result => [...result.named]));

    const hasManifest = existsSync(path.join(repoRoot, MANIFEST));
    if (hasManifest) {
      const manifest = readJson(repoRoot, MANIFEST);
      findings.push(...inspectManifest({ manifest, rootScripts, shownWithArguments }));
      for (const script of manifestScripts(manifest)) named.add(script);
    }

    const allowlists = docs.map(doc => createAllowlist(doc, "scripts"));
    /** @param {string} script */
    const permits = script => allowlists.some(allowlist => allowlist.permits(script));
    findings.push(...inspectUndocumented({ rootScripts, named, permits }));
    if (!hasManifest) consumeEntriesForAbsentScripts({ allowlists, rootScripts });
    findings.push(...allowlists.flatMap(allowlist => allowlist.staleEntries()));
    const scope = hasManifest
      ? `${docs.length} docs and ${MANIFEST}`
      : `${docs.length} docs (no ${MANIFEST}: a scaffold)`;
    return resultFrom(findings, `${rootScripts.size} root scripts against ${scope}`);
  },
};

if (isMainModule(import.meta.url)) await runCli(check);
