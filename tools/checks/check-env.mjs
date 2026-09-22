// @ts-check
import { existsSync } from "node:fs";
import path from "node:path";
import { codeLines, parseMarkdown, sectionsTitled } from "./lib/markdown.mjs";
import { isMainModule, resultFrom, runCli } from "./lib/report.mjs";
import { listCodeFiles, listDocs, listTrackedFiles, readJson, readText } from "./lib/repo.mjs";

const MANIFEST = "template.json";
const ENV_NAME = /(?<![\w$])_*[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![\w$])/g;
const ENV_SECTION = /environment|env vars?/i;

/** Set by the runtime or the host, never by the developer: not expected in any `.env.example`. */
const PLATFORM = /^(?:NODE_ENV|CI|PORT|VERCEL_\w+)$/;

const ENV_ACCESS =
  /process\.env(?:\.([A-Za-z_$][\w$]*)|\[\s*(?:["']([^"']+)["']|([^\]]+?))\s*\])\s*(\|\||\?\?|=(?!=))?/g;
const STRING_CONSTANT = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']+)["']/g;
const CROSS_ENV_ASSIGNMENT = /\bcross-env((?:\s+[A-Za-z_][A-Za-z0-9_]*=\S+)+)/g;
/** A key of a `.env.example`, commented out or not: an optional variable is often listed commented out. */
const EXAMPLE_KEY = /^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** @typedef {"required" | "optional"} Claim */
/** @typedef {{ file: string, line?: number }} Place */
/** @typedef {Place & { name: string, assigned: boolean, hasFallback: boolean }} EnvRead */
/**
 * @typedef {object} EnvSets
 * @property {EnvRead[]} reads every `process.env` access in the code, assignments included
 * @property {Place[]} unresolved accesses whose variable name is computed and cannot be followed
 * @property {Set<string>} setByScripts variables a package script sets for the command it runs
 * @property {Map<string, Place>} examples variable to the first `.env.example` line that lists it
 * @property {Set<string>} named variables any doc names in code
 * @property {Map<string, Place>} declared variables listed in an environment section of a doc
 * @property {Map<string, { claim: Claim, place: Place }>} docClaims
 * @property {Map<string, Claim | undefined> | undefined} manifest `envVars` of the template manifest, when there is one
 */

/**
 * @param {string} file
 * @param {string} code
 * @param {Map<string, string>} constants string constants declared anywhere in the code, by identifier
 * @returns {Pick<EnvSets, "reads" | "unresolved">}
 */
export function findEnvReads(file, code, constants) {
  /** @type {EnvRead[]} */
  const reads = [];
  /** @type {Place[]} */
  const unresolved = [];
  code.split(/\r?\n/).forEach((text, index) => {
    const place = { file, line: index + 1 };
    for (const [, dotted, quoted, computed, operator] of text.matchAll(ENV_ACCESS)) {
      const name = dotted ?? quoted ?? constants.get(computed.trim());
      if (name === undefined) unresolved.push(place);
      else
        reads.push({ ...place, name, assigned: operator === "=", hasFallback: operator === "||" || operator === "??" });
    }
  });
  return { reads, unresolved };
}

/**
 * @param {string} text the description of a variable, or the cell of a "required?" column
 * @returns {Claim | undefined}
 */
export function readClaim(text) {
  if (/\boptional\b|\bnot required\b|^\s*no\b/i.test(text)) return "optional";
  return /\brequired\b|^\s*yes\b/i.test(text) ? "required" : undefined;
}

/**
 * @param {string} line
 * @returns {string[] | undefined} the cells when the line is a table row
 */
function tableCells(line) {
  const row = line.trim();
  return row.startsWith("|") ? row.replace(/^\||\|$/g, "").split("|") : undefined;
}

/**
 * @param {import("./lib/markdown.mjs").MarkdownDoc} doc
 * @returns {Pick<EnvSets, "named" | "declared" | "docClaims">}
 */
export function readDocEnv(doc) {
  const named = new Set(codeLines(doc).flatMap(({ text }) => text.match(ENV_NAME) ?? []));
  /** @type {EnvSets["declared"]} */
  const declared = new Map();
  /** @type {EnvSets["docClaims"]} */
  const docClaims = new Map();

  for (const { from, to } of sectionsTitled(doc, ENV_SECTION)) {
    /** @type {number | undefined} column of the table in progress that says whether a variable is required */
    let requiredColumn;
    for (let line = from; line <= to; line += 1) {
      const cells = tableCells(doc.lines[line - 1]);
      const isHeader = cells !== undefined && tableCells(doc.lines[line - 2] ?? "") === undefined;
      if (isHeader) requiredColumn = cells.findIndex(cell => /required/i.test(cell));
      if (cells === undefined) requiredColumn = undefined;

      for (const span of doc.spans.filter(candidate => candidate.line === line)) {
        for (const name of span.text.match(ENV_NAME) ?? []) {
          const place = { file: doc.file, line };
          declared.set(name, place);
          const claim = cells && requiredColumn !== undefined ? readClaim(cells[requiredColumn] ?? "") : undefined;
          if (claim) docClaims.set(name, { claim, place });
        }
      }
    }
  }
  return { named, declared, docClaims };
}

/**
 * @param {EnvSets} sets
 * @returns {import("./lib/report.mjs").Finding[]}
 */
export function compareEnvSets({ reads, unresolved, setByScripts, examples, named, declared, docClaims, manifest }) {
  const internal = new Set([...setByScripts, ...reads.filter(read => read.assigned).map(read => read.name)]);
  const userReads = reads.filter(read => !internal.has(read.name) && !PLATFORM.test(read.name));
  const readNames = new Set(reads.map(read => read.name));
  const withFallback = new Set(reads.filter(read => read.hasFallback).map(read => read.name));
  /** @type {Map<string, Place>} first place each developer-facing variable is used: an example file, else a read */
  const usedAt = new Map(examples);
  for (const read of userReads) if (!usedAt.has(read.name)) usedAt.set(read.name, read);
  /** @type {import("./lib/report.mjs").Finding[]} */
  const findings = [];
  /**
   * @param {Place} place
   * @param {string} message
   */
  const report = ({ file, line }, message) =>
    findings.push(line === undefined ? { file, message } : { file, line, message });
  const inManifestFile = { file: MANIFEST };

  for (const place of unresolved) report(place, "process.env is indexed by a computed name: use a string constant");
  for (const [name, place] of usedAt) {
    if (!examples.has(name)) report(place, `${name} is read here but no .env.example lists it`);
    if (!readNames.has(name)) report(place, `${name} is listed here but no code reads it`);
    if (!named.has(name)) report(place, `${name} is used here but no doc names it`);
    if (manifest && examples.has(name) && !manifest.has(name)) {
      report(place, `${name} is missing from envVars in ${MANIFEST}`);
    }
  }
  for (const [name, place] of declared) {
    if (!readNames.has(name) && !examples.has(name)) {
      report(place, `${name} is documented as a variable, but nothing reads or lists it`);
    }
  }
  for (const [name, inManifest] of manifest ?? []) {
    const inDocs = docClaims.get(name);
    if (!examples.has(name)) report(inManifestFile, `envVars lists ${name}, no .env.example does`);
    if (inDocs && inManifest && inDocs.claim !== inManifest) {
      report(inDocs.place, `${name} is ${inDocs.claim} here and ${inManifest} in ${MANIFEST}`);
    }
    if (inManifest === "required" && withFallback.has(name)) {
      report(inManifestFile, `${name} is called required, but the code falls back to a default`);
    }
  }
  for (const [name, { claim, place }] of docClaims) {
    if (claim === "required" && withFallback.has(name)) {
      report(place, `${name} is called required, but the code falls back to a default`);
    }
  }
  return findings;
}

/**
 * @param {string} repoRoot
 * @param {string[]} tracked
 * @returns {Set<string>}
 */
function variablesSetByScripts(repoRoot, tracked) {
  const scripts = tracked
    .filter(file => path.posix.basename(file) === "package.json")
    .flatMap(file => Object.values(readJson(repoRoot, file).scripts ?? {}));
  return new Set(
    scripts
      .flatMap(script => [...String(script).matchAll(CROSS_ENV_ASSIGNMENT)])
      .flatMap(([, assignments]) => assignments.trim().split(/\s+/))
      .map(assignment => assignment.split("=")[0]),
  );
}

/** @type {import("./lib/report.mjs").Check} */
export const check = {
  name: "check-env",
  run({ repoRoot }) {
    const tracked = listTrackedFiles(repoRoot);
    const code = listCodeFiles(tracked).map(file => ({ file, text: readText(repoRoot, file) }));
    /** @type {Map<string, string>} */
    const constants = new Map();
    for (const { text } of code) for (const [, id, value] of text.matchAll(STRING_CONSTANT)) constants.set(id, value);
    const scanned = code.map(({ file, text }) => findEnvReads(file, text, constants));

    /** @type {EnvSets["examples"]} */
    const examples = new Map();
    for (const file of tracked.filter(candidate => path.posix.basename(candidate) === ".env.example")) {
      readText(repoRoot, file)
        .split(/\r?\n/)
        .forEach((text, index) => {
          const name = EXAMPLE_KEY.exec(text)?.[1];
          if (name !== undefined && !examples.has(name)) examples.set(name, { file, line: index + 1 });
        });
    }
    const docs = listDocs(tracked).map(file => readDocEnv(parseMarkdown(file, readText(repoRoot, file))));
    /** @type {{ key: string, description: string }[] | undefined} */
    const envVars = existsSync(path.join(repoRoot, MANIFEST))
      ? readJson(repoRoot, MANIFEST)["create-scaffold-hbar"]?.envVars
      : undefined;

    const reads = scanned.flatMap(result => result.reads);
    const findings = compareEnvSets({
      reads,
      unresolved: scanned.flatMap(result => result.unresolved),
      setByScripts: variablesSetByScripts(repoRoot, tracked),
      examples,
      named: new Set(docs.flatMap(doc => [...doc.named])),
      declared: new Map(docs.flatMap(doc => [...doc.declared])),
      docClaims: new Map(docs.flatMap(doc => [...doc.docClaims])),
      manifest: envVars && new Map(envVars.map(({ key, description }) => [key, readClaim(description)])),
    });
    const readCount = new Set(reads.map(read => read.name)).size;
    return resultFrom(
      findings,
      `${readCount} variables read, ${examples.size} in .env.example files, ${docs.length} docs`,
    );
  },
};

if (isMainModule(import.meta.url)) await runCli(check);
