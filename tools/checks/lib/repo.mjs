// @ts-check
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { YARN } from "./package-manager.mjs";
import { UnverifiableError } from "./report.mjs";

const GIT_OUTPUT_LIMIT = 256 * 1024 * 1024;

/** Not ours to judge: the hosts' agent kit, the optional skills install, the vendored package-manager release. */
const HOST_KIT = [".agents/", ".claude/", "agent/", `.${YARN}/`];
const HOST_KIT_FILES = new Set(["skills-lock.json"]);

/** The checkers' own fixtures and tests name the very defects they prove. */
const CHECK_MATERIAL = ["tools/checks/fixtures/", "tools/checks/test/"];

const LOCKFILE = /(^|\/)[\w.-]*(?:\.lock|-lock\.json|-lock\.yaml)$/;
const ASSET = /\.(?:png|jpe?g|gif|ico|svg|webp|woff2?|ttf|pdf)$/i;
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * @param {string} repoRoot
 * @param {string[]} args
 * @param {string} [input] written to the command's standard input
 * @returns {string}
 */
export function git(repoRoot, args, input) {
  try {
    return execFileSync("git", ["-c", "core.quotePath=false", "-C", repoRoot, ...args], {
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_LIMIT,
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new UnverifiableError(`git ${args.join(" ")} failed in ${repoRoot}: is it a git repository?`, {
      cause: error,
    });
  }
}

/**
 * @param {string} repoRoot
 * @returns {string[]} tracked paths still present in the working tree, forward slashes, relative to the root
 */
export function listTrackedFiles(repoRoot) {
  const deleted = new Set(git(repoRoot, ["ls-files", "--deleted", "-z"]).split("\0"));
  return git(repoRoot, ["ls-files", "-z"])
    .split("\0")
    .filter(file => file !== "" && !deleted.has(file));
}

/**
 * @param {string} repoRoot
 * @param {string[]} paths
 * @returns {Set<string>} the paths that the repository's ignore rules cover, tracked or not
 */
export function listIgnored(repoRoot, paths) {
  if (paths.length === 0) return new Set();
  const result = spawnSync("git", ["-C", repoRoot, "check-ignore", "--no-index", "--", ...paths], { encoding: "utf8" });
  // Exit 1 means "none of these is ignored": an answer, not a failure.
  if (result.status === 0 || result.status === 1) return new Set(result.stdout.split("\n").filter(Boolean));
  throw new UnverifiableError(`git check-ignore failed in ${repoRoot}: ${result.stderr || result.error?.message}`);
}

/**
 * @param {string} file
 * @returns {boolean}
 */
export function isHostKit(file) {
  return HOST_KIT_FILES.has(file) || HOST_KIT.some(prefix => file.startsWith(prefix));
}

/**
 * @param {string} file
 * @returns {boolean} true for the files whose content the docs describe and the checks judge
 */
function isInScope(file) {
  return !isHostKit(file) && !CHECK_MATERIAL.some(prefix => file.startsWith(prefix));
}

/**
 * @param {string[]} tracked
 * @returns {string[]} what a developer reads: every README.md and AGENTS.md of the repository, the tools' own
 * included, and the Markdown files under `docs/`
 */
export function listDocs(tracked) {
  return tracked.filter(
    file => isInScope(file) && (/(^|\/)(?:README|AGENTS)\.md$/.test(file) || /^docs\/.+\.md$/.test(file)),
  );
}

/**
 * @param {string} file
 * @returns {boolean}
 */
export function isLockfile(file) {
  return LOCKFILE.test(file);
}

/**
 * @param {string[]} tracked
 * @returns {string[]} files whose text counts as "the source" when a doc names something
 */
export function listSourceFiles(tracked) {
  return tracked.filter(file => isInScope(file) && !file.endsWith(".md") && !isLockfile(file) && !ASSET.test(file));
}

/**
 * @param {string[]} tracked
 * @returns {string[]}
 */
export function listCodeFiles(tracked) {
  return listSourceFiles(tracked).filter(file => CODE_FILE.test(file));
}

/**
 * @param {string} repoRoot
 * @param {string} file
 * @returns {string}
 */
export function readText(repoRoot, file) {
  return readFileSync(path.join(repoRoot, file), "utf8");
}

/**
 * @param {string} repoRoot
 * @param {string} file
 * @returns {any}
 */
export function readJson(repoRoot, file) {
  const text = readText(repoRoot, file);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON`, { cause: error });
  }
}

/**
 * @param {string} repoRoot
 * @returns {Set<string>} the scripts of the root package, the only ones a doc may tell a developer to run
 */
export function readRootScripts(repoRoot) {
  return new Set(Object.keys(readJson(repoRoot, "package.json").scripts ?? {}));
}

/**
 * @param {string[]} tracked
 * @returns {string[]} directories of the workspace packages
 */
export function listWorkspaceDirs(tracked) {
  return tracked
    .filter(file => isInScope(file) && file.endsWith("/package.json"))
    .map(file => path.posix.dirname(file));
}
