// @ts-check
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { findSymbolFindings, identifiersIn } from "../check-symbols.mjs";
import { parseMarkdown } from "../lib/markdown.mjs";
import { listModuleExports, loadTypeScript, loadWorkspace } from "../lib/typescript.mjs";
import { FIXTURES, REPO_ROOT, fixtureDoc, readFixture } from "./support.mjs";

const SOURCE_WORDS = new Set(["useLedgerAccount"]);
const dependencies = {
  /** @param {string} name */
  has: name => name === "@fixture/ui",
  exportsOf: () => new Set(["AccountBadge", "formatAmount"]),
};

/** @param {import("../lib/markdown.mjs").MarkdownDoc} doc */
function check(doc) {
  return findSymbolFindings({ doc, inSource: word => SOURCE_WORDS.has(word), dependencies });
}

test("a component the named package does not export is refused, the one it exports passes", () => {
  assert.deepEqual(check(fixtureDoc("agent-guide.markdown", "AGENTS.md")), [
    {
      file: "AGENTS.md",
      line: 3,
      message: "`AmountInput` is not in the tracked source; @fixture/ui does not export it",
    },
  ]);
});

test("a deliberate negative needs the allowlist block: without it the wrong name is refused too", () => {
  const withoutBlock = readFixture("agent-guide.markdown").replace(/<!--[\s\S]*-->/, "");
  const messages = check(parseMarkdown("AGENTS.md", withoutBlock)).map(finding => finding.message);
  assert.deepEqual(messages, [
    "`AmountInput` is not in the tracked source; @fixture/ui does not export it",
    "`useAccountLedger` is not in the tracked source",
  ]);
});

test("a package whose types cannot be resolved is named as the reason, not passed over", () => {
  const unresolved = { has: dependencies.has, exportsOf: () => undefined };
  const doc = fixtureDoc("agent-guide.markdown", "AGENTS.md");
  const [finding] = findSymbolFindings({ doc, inSource: word => SOURCE_WORDS.has(word), dependencies: unresolved });
  assert.match(finding.message, /the types of @fixture\/ui cannot be resolved/);
});

test("only code spellings are identifiers: prose words, paths, flags and hex literals are not", () => {
  assert.deepEqual(identifiersIn("HederaToken.mint"), ["HederaToken"]);
  assert.deepEqual(identifiersIn("deployToken.tags = [MAX_SUPPLY]"), ["deployToken", "MAX_SUPPLY"]);
  assert.deepEqual(identifiersIn("hardhat-deploy --network localhost 0xAbCdEf12"), []);
  assert.deepEqual(identifiersIn("packages/nextjs/hooks/useLedgerAccount.ts"), []);
});

test("the names of naming conventions in a style table are not identifiers", () => {
  for (const style of ["UpperCamelCase", "lowerCamelCase", "CONSTANT_CASE"]) assert.deepEqual(identifiersIn(style), []);
  assert.deepEqual(identifiersIn("UpperCamelCaseButton"), ["UpperCamelCaseButton"]);
});

test("export lists come from the compiler, through the workspace's own module resolution", t => {
  let ts;
  try {
    ts = loadTypeScript(path.join(REPO_ROOT, "packages", "nextjs"));
  } catch (error) {
    t.skip(`typescript is not installed: ${error instanceof Error ? error.message : error}`);
    return;
  }
  const workspace = loadWorkspace(path.join(FIXTURES, "workspace"), ts);
  const exported = listModuleExports(workspace, "@fixture/ui");
  assert.deepEqual([...(exported ?? [])].sort(), ["AccountBadge", "formatAmount"]);
  assert.equal(listModuleExports(workspace, "@fixture/absent"), undefined);
});
