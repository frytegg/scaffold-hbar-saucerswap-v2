// @ts-check
import path from "node:path";
import { parseMarkdown } from "./lib/markdown.mjs";
import { isMainModule, resultFrom, runCli } from "./lib/report.mjs";
import { listDocs, listTrackedFiles, listWorkspaceDirs, readText } from "./lib/repo.mjs";
import { loadWorkspace, typeCheckVirtualFiles } from "./lib/typescript.mjs";

/** Where a snippet is compiled unless its fence names another workspace, as in "```ts packages/hardhat". */
const DEFAULT_WORKSPACE = "packages/nextjs";
const TYPESCRIPT_FENCE = /^(ts|tsx|typescript)(?:\s+(\S+))?$/;

/**
 * @typedef {object} Snippet
 * @property {string} doc
 * @property {number} line first content line in the doc
 * @property {string} workspace
 * @property {string} fileName virtual name inside the workspace
 * @property {string} code
 */

/**
 * @param {import("./lib/markdown.mjs").MarkdownDoc} doc
 * @returns {Snippet[]}
 */
export function extractSnippets(doc) {
  return doc.fences.flatMap(fence => {
    const info = TYPESCRIPT_FENCE.exec(fence.info);
    if (!info) return [];
    const extension = info[1] === "tsx" ? "tsx" : "ts";
    return [
      {
        doc: doc.file,
        line: fence.line,
        workspace: info[2] ?? DEFAULT_WORKSPACE,
        fileName: `doc-snippets/${doc.file.replace(/[^\w.-]/g, "_")}.L${fence.line}.${extension}`,
        // Each snippet is its own module: two snippets may declare the same name, and top-level await is allowed.
        code: `${fence.lines.join("\n")}\nexport {};\n`,
      },
    ];
  });
}

/**
 * @param {Snippet[]} snippets
 * @param {Set<string>} workspaceDirs
 * @returns {import("./lib/report.mjs").Finding[]} one per snippet whose fence names a directory that is no workspace
 */
export function findMisplacedSnippets(snippets, workspaceDirs) {
  return snippets
    .filter(snippet => !workspaceDirs.has(snippet.workspace))
    .map(snippet => ({
      file: snippet.doc,
      line: snippet.line - 1,
      message: `the fence names "${snippet.workspace}", which is not a workspace package: nothing can compile it`,
    }));
}

/**
 * @param {Snippet[]} snippets
 * @param {(workspaceDir: string) => import("./lib/typescript.mjs").Workspace} openWorkspace
 * @returns {import("./lib/report.mjs").Finding[]}
 */
export function typeCheckSnippets(snippets, openWorkspace) {
  const workspaces = new Set(snippets.map(snippet => snippet.workspace));
  return [...workspaces].flatMap(workspaceDir => {
    const mine = snippets.filter(snippet => snippet.workspace === workspaceDir);
    const files = new Map(mine.map(snippet => [snippet.fileName, snippet.code]));
    return typeCheckVirtualFiles(openWorkspace(workspaceDir), files).map(diagnostic => {
      const snippet = mine.find(candidate => candidate.fileName === diagnostic.file);
      if (!snippet) throw new Error(`diagnostic for an unknown snippet file: ${diagnostic.file}`);
      return { file: snippet.doc, line: snippet.line + diagnostic.line - 1, message: diagnostic.message };
    });
  });
}

/** @type {import("./lib/report.mjs").Check} */
export const check = {
  name: "check-snippets",
  run({ repoRoot }) {
    const tracked = listTrackedFiles(repoRoot);
    const workspaceDirs = new Set(listWorkspaceDirs(tracked));
    const snippets = listDocs(tracked)
      .map(file => parseMarkdown(file, readText(repoRoot, file)))
      .flatMap(extractSnippets);
    const placed = snippets.filter(snippet => workspaceDirs.has(snippet.workspace));
    const findings = [
      ...findMisplacedSnippets(snippets, workspaceDirs),
      ...typeCheckSnippets(placed, workspaceDir => loadWorkspace(path.resolve(repoRoot, workspaceDir))),
    ];
    return resultFrom(findings, `${snippets.length} TypeScript snippets`);
  },
};

if (isMainModule(import.meta.url)) await runCli(check);
