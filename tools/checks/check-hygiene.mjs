// @ts-check
import { isMainModule, resultFrom, runCli, UnverifiableError } from "./lib/report.mjs";
import { git, isHostKit, isLockfile, readText } from "./lib/repo.mjs";

/** @typedef {import("./lib/report.mjs").Finding} Finding */
/** @typedef {{ file: string, mode: string, size: number }} TreeEntry */

const SIZE_LIMIT = 1024 * 1024;
const SYMLINK_MODE = "120000";
const ENV_FILE = /(^|\/)\.env(?:\.[^/]*)?$/;
const ENV_TEMPLATE = /(^|\/)\.env\.example$/;
const LICENCE_FILE = /^LICEN[CS]E(?:\.txt|\.md)?$/;

/** Configuration of AI coding tools. The hosts ship `.agents/`, `.claude/`, AGENTS.md and CLAUDE.md: nothing else. */
const AI_TOOL_ENTRIES = [
  ".aider.conf.yml",
  ".amazonq",
  ".augment",
  ".clinerules",
  ".codex",
  ".continue",
  ".cursor",
  ".cursorrules",
  ".gemini",
  ".github/copilot-instructions.md",
  ".github/skills",
  ".opencode",
  ".windsurf",
  ".windsurfrules",
];

/** One developer's settings for a tool of the kit: never part of it, even inside its directory. */
const PERSONAL_SETTINGS = new Set([".claude/settings.local.json"]);

const UPSTREAM_COPYRIGHT_HOLDERS = ["BuidlGuidl", "hedera-dev"];

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/**
 * @param {string} text
 * @returns {string}
 */
function singleSpaced(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * @param {string} file
 * @returns {boolean} true for a dotenv file that can hold real values
 */
function holdsSecrets(file) {
  return ENV_FILE.test(file) && !ENV_TEMPLATE.test(file);
}

/**
 * The hosts' kit is theirs, and so is what the CLI's skills step adds to it (on POSIX, symbolic links under
 * `.claude/skills`): only secrets and personal settings are refused there.
 * @param {TreeEntry[]} entries the tracked tree
 * @returns {Finding[]}
 */
export function inspectTree(entries) {
  return entries.flatMap(({ file, mode, size }) => {
    /** @type {Finding[]} */
    const findings = [];
    if (holdsSecrets(file)) {
      findings.push({ file, message: "a dotenv file is tracked: only .env.example belongs in git" });
    }
    if (PERSONAL_SETTINGS.has(file)) {
      findings.push({ file, message: "personal settings of an AI tool: they belong to one machine, not to the kit" });
    }
    if (isHostKit(file)) return findings;

    if (mode === SYMLINK_MODE) findings.push({ file, message: "symbolic link: it becomes a text file on Windows" });
    if (size > SIZE_LIMIT && !isLockfile(file)) {
      findings.push({ file, message: `${(size / SIZE_LIMIT).toFixed(1)} MB: over the 1 MB limit for a tracked file` });
    }
    const tool = AI_TOOL_ENTRIES.find(entry => `/${file}/`.includes(`/${entry}/`));
    if (tool) findings.push({ file, message: `${tool} configures an AI tool the hosts' kit does not include` });
    return findings;
  });
}

/**
 * @param {string} log output of `git log --name-only --format="commit %H"`, additions only
 * @returns {Finding[]} dotenv files that any commit on any ref ever added, tracked today or not
 */
export function inspectHistory(log) {
  /** @type {Map<string, string[]>} */
  const commitsByFile = new Map();
  let commit = "";
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith("commit ")) commit = line.slice("commit ".length, "commit ".length + 7);
    else if (holdsSecrets(line)) commitsByFile.set(line, [...(commitsByFile.get(line) ?? []), commit]);
  }
  return [...commitsByFile].map(([file, commits]) => ({
    file,
    message: `added by commit ${commits.join(", ")}: history keeps it for every clone, rotate what it held`,
  }));
}

/**
 * @param {Map<string, string>} licences root licence files, name to text
 * @returns {Finding[]}
 */
export function inspectLicence(licences) {
  if (licences.size === 0) return [{ file: "LICENCE", message: "no licence file at the root" }];
  return [...licences].flatMap(([file, text]) => {
    /** @type {Finding[]} */
    const findings = [];
    if (!/^\s*MIT License\b/.test(text) || !singleSpaced(text).endsWith(singleSpaced(MIT_TERMS))) {
      findings.push({
        file,
        message: 'not the unmodified MIT text: it starts with "MIT License" and ends with the terms',
      });
    }
    for (const holder of UPSTREAM_COPYRIGHT_HOLDERS) {
      if (!new RegExp(`^Copyright \\(c\\) .*${holder}`, "m").test(text)) {
        findings.push({ file, message: `the upstream copyright notice of ${holder} is missing` });
      }
    }
    return findings;
  });
}

/** @type {import("./lib/report.mjs").Check} */
export const check = {
  name: "check-hygiene",
  run({ repoRoot }) {
    if (git(repoRoot, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
      throw new UnverifiableError(
        "the clone is shallow, so history cannot be walked: fetch all of it (fetch-depth: 0)",
      );
    }
    // The index, not the working tree: what the next commit holds.
    const records = git(repoRoot, ["ls-files", "-s", "-z"])
      .split("\0")
      .filter(Boolean)
      .map(record => {
        const [meta, file] = record.split("\t");
        const [mode, objectId] = meta.split(" ");
        return { file, mode, objectId };
      });
    const objectIds = `${records.map(record => record.objectId).join("\n")}\n`;
    const sizes = git(repoRoot, ["cat-file", "--batch-check=%(objectsize)"], objectIds).split("\n").map(Number);
    /** @type {TreeEntry[]} */
    const entries = records.map(({ file, mode }, index) => ({ file, mode, size: sizes[index] || 0 }));
    const licences = new Map(
      entries.filter(({ file }) => LICENCE_FILE.test(file)).map(({ file }) => [file, readText(repoRoot, file)]),
    );
    // Trees are walked locally and on every ref: a hosting API filtered by path does not list a file that was removed.
    const additions = [
      "log",
      "--all",
      "-m",
      "--root",
      "--no-renames",
      "--diff-filter=A",
      "--name-only",
      "--format=commit %H",
    ];
    const history = git(repoRoot, additions);

    const findings = [...inspectTree(entries), ...inspectHistory(history), ...inspectLicence(licences)];
    const commits = git(repoRoot, ["rev-list", "--all", "--count"]).trim();
    return resultFrom(findings, `${entries.length} tracked files, ${commits} commits on all refs`);
  },
};

if (isMainModule(import.meta.url)) await runCli(check);
