// @ts-check
import path from "node:path";
import { createAllowlist, parseMarkdown } from "./lib/markdown.mjs";
import { YARN } from "./lib/package-manager.mjs";
import { isMainModule, resultFrom, runCli } from "./lib/report.mjs";
import { listDocs, listIgnored, listTrackedFiles, readText } from "./lib/repo.mjs";

const FILE_EXTENSION = /\.(?:md|json|[cm]?[jt]s|[jt]sx|sol|ya?ml|toml|css|sh|lock|example|local)$/;
const DOTFILE = /^\.[a-z][\w.-]*$/;
/** One entry of a drawn directory tree, as `tree` prints it or as people type it. */
const TREE_BRANCH = /^[\s│|]*(?:├──|└──|├─|└─|\|--|`--)\s*([^\s#←]+)/;

/** Tracked here, yet missing from what a developer scaffolds: the CLI removes them. */
const REMOVED_BY_THE_CLI = new Map([
  ["template.json", "the CLI deletes it from every scaffold"],
  ...[".husky", `.${YARN}`, `.${YARN}rc.yml`, `${YARN}.lock`].map(
    removed => /** @type {[string, string]} */ ([removed, "the CLI deletes it from npm-mode scaffolds"]),
  ),
]);

/**
 * @param {string} span the text of an inline code span
 * @returns {string | undefined} the repository path it names, if it names one
 */
export function pathCandidate(span) {
  const token = span.replace(/[.,;]$/, "").split(":")[0];
  if (token === "" || /\s/.test(token) || /^[@~/#]/.test(token) || /…|\.\.\.|node_modules/.test(token))
    return undefined;
  if (/^[A-Z0-9]+\/[A-Z0-9]+$/.test(token) || token.includes("#")) return undefined;
  if (token.includes("/")) return token.replace(/^\.\//, "").replace(/\/$/, "");
  return FILE_EXTENSION.test(token) || DOTFILE.test(token) ? token : undefined;
}

/**
 * @param {string} token
 * @returns {string[]} one entry per alternative of each `{a,b}` group
 */
export function expandBraces(token) {
  const group = /^(.*?)\{([^{}]+)\}(.*)$/.exec(token);
  if (!group) return [token];
  return group[2].split(",").flatMap(alternative => expandBraces(group[1] + alternative.trim() + group[3]));
}

/**
 * @param {string} candidate may hold `<placeholder>` segments and `*` globs
 * @returns {RegExp} matches a tracked file, or any file below a tracked directory
 */
function toPattern(candidate) {
  const escaped = candidate
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/<[^>/]+>/g, "[^/]+")
    .replace(/\*\*|\*/g, glob => (glob === "**" ? ".*" : "[^/]*"));
  return new RegExp(`^${escaped}(?:/|$)`);
}

/**
 * @param {string} candidate
 * @param {string} docDir directory of the doc that names it
 * @returns {string[]} the places the author may have meant, most literal first; a bare name may sit anywhere
 */
function resolutions(candidate, docDir) {
  const fromDoc = path.posix.normalize(path.posix.join(docDir, candidate));
  return candidate.includes("/") ? [candidate, fromDoc] : [candidate, fromDoc, `**/${candidate}`];
}

/**
 * @param {import("./lib/markdown.mjs").MarkdownDoc} doc
 * @returns {{ line: number, name: string }[]} the entries of the directory trees a doc draws in fenced blocks
 */
export function treeEntries(doc) {
  return doc.fences.flatMap(fence =>
    fence.lines.flatMap((text, offset) => {
      const name = TREE_BRANCH.exec(text)?.[1].replace(/\/$/, "");
      return name && !/[<*…]|\.\.\./.test(name) ? [{ line: fence.line + offset, name }] : [];
    }),
  );
}

/**
 * @param {object} input
 * @param {import("./lib/markdown.mjs").MarkdownDoc} input.doc
 * @param {string[]} input.tracked
 * @param {(paths: string[]) => Set<string>} input.ignoredAmong which of these untracked paths the ignore rules cover
 * @returns {import("./lib/report.mjs").Finding[]}
 */
export function findPathFindings({ doc, tracked, ignoredAmong }) {
  const allowlist = createAllowlist(doc, "paths");
  const docDir = path.posix.dirname(doc.file);
  /** @type {import("./lib/report.mjs").Finding[]} */
  const findings = [];

  // A drawn tree loses the parent of each entry on the way, so an entry only has to exist somewhere.
  const ignoreDirs = tracked.filter(file => path.posix.basename(file) === ".gitignore").map(path.posix.dirname);
  for (const { line, name } of treeEntries(doc)) {
    if (allowlist.permits(name) || tracked.some(file => `/${file}/`.includes(`/${name}/`))) continue;
    if (ignoredAmong(ignoreDirs.map(dir => path.posix.join(dir, name))).size > 0) continue;
    findings.push({ file: doc.file, line, message: `the tree shows "${name}", which no tracked path holds` });
  }

  for (const span of doc.spans) {
    const candidate = pathCandidate(span.text);
    if (candidate === undefined || allowlist.permits(candidate)) continue;
    for (const expanded of expandBraces(candidate)) {
      const removal = REMOVED_BY_THE_CLI.get(expanded.split("/")[0]);
      if (removal) {
        findings.push({ file: doc.file, line: span.line, message: `\`${expanded}\` is not in a scaffold: ${removal}` });
        continue;
      }
      const places = resolutions(expanded, docDir);
      const isTracked = places.map(toPattern).some(pattern => tracked.some(file => pattern.test(file)));
      if (isTracked || ignoredAmong(places.slice(0, 2)).size > 0) continue;
      findings.push({ file: doc.file, line: span.line, message: `\`${expanded}\` is not a tracked path` });
    }
  }
  return [...findings, ...allowlist.staleEntries()];
}

/** @type {import("./lib/report.mjs").Check} */
export const check = {
  name: "check-paths",
  run({ repoRoot }) {
    const tracked = listTrackedFiles(repoRoot);
    const docs = listDocs(tracked).map(file => parseMarkdown(file, readText(repoRoot, file)));
    // Generated and local files (build output, `.env`) are legitimate doc targets although git does not track them.
    /** @param {string[]} paths */
    const ignoredAmong = paths =>
      listIgnored(
        repoRoot,
        paths.filter(candidate => !/[<*]/.test(candidate)),
      );
    const findings = docs.flatMap(doc => findPathFindings({ doc, tracked, ignoredAmong }));
    const named = docs.reduce(
      (count, doc) => count + doc.spans.filter(span => pathCandidate(span.text)).length + treeEntries(doc).length,
      0,
    );
    return resultFrom(findings, `${named} path references in ${docs.length} docs`);
  },
};

if (isMainModule(import.meta.url)) await runCli(check);
