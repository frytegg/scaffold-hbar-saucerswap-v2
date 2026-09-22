// @ts-check
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown } from "../lib/markdown.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURES = path.resolve(HERE, "..", "fixtures");
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/**
 * Fixtures that name a package manager are stored as `.markdown`, an extension the CLI's npm-mode rewrite leaves
 * alone, so that they say the same thing in every scaffold.
 * @param {string} name
 * @returns {string}
 */
export function readFixture(name) {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

/**
 * @param {string} name
 * @param {string} [asFile] the repository path the doc pretends to have
 * @returns {import("../lib/markdown.mjs").MarkdownDoc}
 */
export function fixtureDoc(name, asFile = "README.md") {
  return parseMarkdown(asFile, readFixture(name));
}

/**
 * @param {import("../lib/report.mjs").Finding[]} findings
 * @returns {number[]}
 */
export function linesOf(findings) {
  return findings.map(finding => finding.line ?? 0).sort((left, right) => left - right);
}
