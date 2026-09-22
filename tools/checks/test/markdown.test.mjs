// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { codeLines, createAllowlist, parseMarkdown, sectionsTitled } from "../lib/markdown.mjs";

const DOC = [
  "# Title",
  "",
  "Prose with `inline code` and ``a `nested` tick``.",
  "",
  "   ```bash",
  "   # not a heading",
  "   echo `not a span`",
  "   ```",
  "",
  "## Environment variables",
  "",
  "`FIRST_VAR` is described here.",
  "",
  "## Next",
  "",
  "<!-- checks:allow",
  "symbols: alpha, beta",
  "paths: docs/gone.md",
  "-->",
].join("\n");

test("text inside a fence is neither a span nor a heading, even when the fence is indented", () => {
  const doc = parseMarkdown("README.md", DOC);
  assert.deepEqual(
    doc.spans.map(span => span.text),
    ["inline code", "a `nested` tick", "FIRST_VAR"],
  );
  assert.deepEqual(
    doc.headings.map(heading => heading.title),
    ["Title", "Environment variables", "Next"],
  );
  assert.deepEqual(doc.fences, [{ line: 6, info: "bash", lines: ["   # not a heading", "   echo `not a span`"] }]);
});

test("code lines carry the line number they have in the doc", () => {
  const lines = codeLines(parseMarkdown("README.md", DOC));
  assert.deepEqual(
    lines.find(entry => entry.text.includes("echo")),
    { line: 7, text: "   echo `not a span`" },
  );
});

test("prose keeps its columns but loses its inline code", () => {
  const prose = parseMarkdown("README.md", DOC).prose.find(entry => entry.line === 3);
  assert.equal(prose?.text.includes("inline code"), false);
  assert.equal(prose?.text.length, DOC.split("\n")[2].length);
});

test("a section runs until the next heading of the same or a higher level", () => {
  const doc = parseMarkdown("README.md", DOC);
  assert.deepEqual(sectionsTitled(doc, /environment/i), [{ from: 10, to: 13 }]);
});

test("an allowlist block shown inside a fence is an example, not a declaration", () => {
  const doc = parseMarkdown("README.md", "```markdown\n<!-- checks:allow\nsymbols: alpha\n-->\n```");
  assert.equal(doc.allow.size, 0);
});

test("an allowlist entry that excuses nothing is reported as stale", () => {
  const allowlist = createAllowlist(parseMarkdown("AGENTS.md", DOC), "symbols");
  assert.equal(allowlist.permits("alpha"), true);
  assert.equal(allowlist.permits("gamma"), false);
  assert.deepEqual(
    allowlist.staleEntries().map(finding => finding.message),
    ['allowlist entry "symbols: beta" excuses nothing in this file: remove it'],
  );
});
