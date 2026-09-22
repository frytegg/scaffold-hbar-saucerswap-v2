// @ts-check
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { extractSnippets, findMisplacedSnippets, typeCheckSnippets } from "../check-snippets.mjs";
import { parseMarkdown } from "../lib/markdown.mjs";
import { loadTypeScript, loadWorkspace } from "../lib/typescript.mjs";
import { FIXTURES, REPO_ROOT, fixtureDoc } from "./support.mjs";

test("only TypeScript fences are extracted, each with its doc line and its workspace", () => {
  const snippets = extractSnippets(fixtureDoc("snippets.markdown", "AGENTS.md"));
  assert.deepEqual(
    snippets.map(({ line, workspace, fileName }) => ({ line, workspace, fileName })),
    [
      { line: 6, workspace: "packages/nextjs", fileName: "doc-snippets/AGENTS.md.L6.ts" },
      { line: 14, workspace: "packages/nextjs", fileName: "doc-snippets/AGENTS.md.L14.tsx" },
      { line: 22, workspace: "packages/nextjs", fileName: "doc-snippets/AGENTS.md.L22.ts" },
    ],
  );
});

test("a fence can name the workspace that compiles it, and naming a directory that is none is refused", () => {
  const doc = parseMarkdown(
    "README.md",
    "```ts packages/hardhat\nexport const chainId = 296;\n```\n\n```ts fragment\nx\n```",
  );
  const snippets = extractSnippets(doc);
  assert.equal(snippets[0].workspace, "packages/hardhat");
  assert.deepEqual(findMisplacedSnippets(snippets, new Set(["packages/hardhat", "packages/nextjs"])), [
    {
      file: "README.md",
      line: 5,
      message: 'the fence names "fragment", which is not a workspace package: nothing can compile it',
    },
  ]);
});

test("an import of a name the package does not export fails at its line in the doc", t => {
  let ts;
  try {
    ts = loadTypeScript(path.join(REPO_ROOT, "packages", "nextjs"));
  } catch (error) {
    t.skip(`typescript is not installed: ${error instanceof Error ? error.message : error}`);
    return;
  }
  const snippets = extractSnippets(fixtureDoc("snippets.markdown", "AGENTS.md"));
  const findings = typeCheckSnippets(snippets, () => loadWorkspace(path.join(FIXTURES, "workspace"), ts));
  assert.deepEqual(findings, [
    { file: "AGENTS.md", line: 14, message: "TS2305: Module '\"@fixture/ui\"' has no exported member 'AmountInput'." },
    { file: "AGENTS.md", line: 25, message: "TS2322: Type 'string' is not assignable to type 'number'." },
  ]);
});
