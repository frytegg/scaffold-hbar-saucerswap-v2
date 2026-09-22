// @ts-check
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{ file: string, line?: number, message: string }} Finding */
/** @typedef {"pass" | "fail" | "unverified" | "skipped"} Status */
/** @typedef {{ status: Status, findings: Finding[], summary: string }} CheckResult */
/** @typedef {{ repoRoot: string, allowOffline: boolean }} CheckContext */
/** @typedef {{ name: string, run: (context: CheckContext) => CheckResult | Promise<CheckResult> }} Check */

/** The check could not reach a verdict: something it depends on is missing, unreachable or truncated. */
export class UnverifiableError extends Error {}

class UsageError extends Error {}

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A skipped check has nothing to judge; an unverified one had something and could not judge it. */
const EXIT_CODES = { pass: 0, skipped: 0, fail: 1, unverified: 2 };
const USAGE_EXIT_CODE = 2;

/**
 * @param {Finding[]} findings
 * @param {string} summary what was examined, for the results table
 * @returns {CheckResult}
 */
export function resultFrom(findings, summary) {
  const ordered = [...findings].sort(
    (left, right) => left.file.localeCompare(right.file) || (left.line ?? 0) - (right.line ?? 0),
  );
  return { status: ordered.length === 0 ? "pass" : "fail", findings: ordered, summary };
}

/**
 * @param {string} reason
 * @returns {CheckResult}
 */
export function skipped(reason) {
  return { status: "skipped", findings: [], summary: reason };
}

/**
 * @param {string[]} argv
 * @returns {CheckContext}
 */
function parseArgs(argv) {
  /** @type {CheckContext} */
  const context = { repoRoot: DEFAULT_REPO_ROOT, allowOffline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-offline") {
      context.allowOffline = true;
    } else if (arg === "--repo") {
      const dir = argv[index + 1];
      if (dir === undefined || dir.startsWith("--")) throw new UsageError("--repo needs a directory");
      context.repoRoot = path.resolve(dir);
      index += 1;
    } else {
      throw new UsageError(`unknown argument "${arg}". Usage: [--repo <dir>] [--allow-offline]`);
    }
  }
  return context;
}

/**
 * @returns {CheckContext | undefined} undefined after a usage error has been reported through the exit code
 */
export function readContext() {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    process.exitCode = USAGE_EXIT_CODE;
    return undefined;
  }
}

/**
 * Runs one check and turns anything it throws into a result, so that a crash never reads as a pass.
 * @param {Check} check
 * @param {CheckContext} context
 * @returns {Promise<CheckResult>}
 */
export async function runCheck(check, context) {
  try {
    return await check.run(context);
  } catch (error) {
    if (error instanceof UnverifiableError) {
      return { status: "unverified", findings: [], summary: `COULD NOT VERIFY: ${error.message}` };
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return { status: "unverified", findings: [], summary: `CRASHED: ${detail}` };
  }
}

/**
 * @param {string} name
 * @param {CheckResult} result
 */
export function printResult(name, result) {
  console.log(`${name}: ${result.status.toUpperCase()} (${result.summary})`);
  for (const finding of result.findings) {
    const where = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
    console.log(`  ${where}  ${finding.message}`);
  }
}

/**
 * @param {Status} status
 * @returns {number} 0 on pass or skip, 1 on findings, 2 when no verdict was reached
 */
export function exitCodeFor(status) {
  return EXIT_CODES[status];
}

/**
 * Command-line entry shared by every check.
 * @param {Check} check
 */
export async function runCli(check) {
  const context = readContext();
  if (!context) return;
  const result = await runCheck(check, context);
  printResult(check.name, result);
  process.exitCode = exitCodeFor(result.status);
}

/**
 * @param {string} moduleUrl the caller's `import.meta.url`
 * @returns {boolean} true when that module is the script Node was started with
 */
export function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}
