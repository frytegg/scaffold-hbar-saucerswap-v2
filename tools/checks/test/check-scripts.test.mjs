// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectDocCommands, inspectManifest } from "../check-scripts.mjs";
import { parseMarkdown } from "../lib/markdown.mjs";
import { fixtureDoc, linesOf } from "./support.mjs";

const ROOT_SCRIPTS = new Set(["dev", "lint:strict", "deploy", "verify", "hardhat:compile"]);

/** @param {{ label?: string, command?: string, text?: string }[]} steps */
function manifestWith(steps) {
  return {
    name: "fixture",
    "create-scaffold-hbar": {
      capabilities: { solidityFramework: ["hardhat"] },
      outro: { sections: [{ title: "Next", steps }] },
    },
  };
}

test("a documented command is refused when it carries a flag, under either package manager", () => {
  const { findings } = inspectDocCommands(fixtureDoc("commands.markdown"), ROOT_SCRIPTS);
  const flagged = findings.filter(finding => finding.message.includes("carries a flag"));
  assert.deepEqual(linesOf(flagged), [7, 10]);
});

test("a documented command is refused when no root script has that name", () => {
  const { findings } = inspectDocCommands(fixtureDoc("commands.markdown"), ROOT_SCRIPTS);
  const unknown = findings.filter(finding => finding.message.includes("is not a root script"));
  assert.deepEqual(unknown, [{ file: "README.md", line: 8, message: '"compile:all" is not a root script' }]);
});

test("bare scripts and the install command, with or without its lockfile flag, pass", () => {
  const { findings } = inspectDocCommands(fixtureDoc("commands.markdown"), ROOT_SCRIPTS);
  assert.deepEqual(linesOf(findings), [7, 8, 10]);
});

test("npm's --prefix picks the package a documented script must belong to, and is not a swallowed flag", () => {
  const doc = parseMarkdown(
    "README.md",
    [
      "```bash",
      "npm run browsers --prefix tools/probe",
      "npm run test --prefix=tools/probe",
      "npm run dev --prefix tools/probe",
      "npm run browsers --prefix tools/nothing",
      "npm run browsers --prefix tools/probe --with-deps",
      "```",
    ].join("\n"),
  );
  /** @param {string} dir */
  const scriptsIn = dir => (dir === "tools/probe" ? new Set(["browsers", "test"]) : undefined);
  const { findings, shownWithArguments } = inspectDocCommands(doc, ROOT_SCRIPTS, scriptsIn);
  assert.deepEqual(
    findings.map(({ line, message }) => [line, message]),
    [
      [4, '"dev" is not a tools/probe script'],
      [5, '"tools/nothing" holds no tracked package.json for "browsers" to run in'],
      [6, '"browsers --with-deps" carries a flag, which npm-mode drops: document a flag-free alias script'],
    ],
  );
  assert.equal(shownWithArguments.size, 0);
});

test("a placeholder needs a root script, framework placeholders included", () => {
  const manifest = manifestWith([
    { command: "{run:dev}" },
    { command: "{run:start}" },
    { command: "{run:framework:compile}" },
  ]);
  const findings = inspectManifest({ manifest, rootScripts: ROOT_SCRIPTS, shownWithArguments: new Map() });
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /\{run:start\} needs the root script "start"/);
});

test("a flag after a placeholder is refused, in a command or in text; arguments and chained placeholders pass", () => {
  const manifest = manifestWith([
    { command: "{run:deploy} --network testnet" },
    { text: "Then run {run:verify} 0xabc --force - it is idempotent." },
    { command: "{run:dev} && {run:deploy}" },
    { command: "{run:verify} 0xabc" },
  ]);
  const findings = inspectManifest({ manifest, rootScripts: ROOT_SCRIPTS, shownWithArguments: new Map() });
  assert.deepEqual(
    findings.map(finding => finding.message.split(" follows")[0]),
    [
      'create-scaffold-hbar.outro.sections[0].steps[0].command: "--network"',
      'create-scaffold-hbar.outro.sections[0].steps[1].text: "--force"',
    ],
  );
});

test("an outro step is refused when it runs bare a script the docs only show with arguments", () => {
  const { shownWithArguments } = inspectDocCommands(fixtureDoc("commands.markdown"), ROOT_SCRIPTS);
  const manifest = manifestWith([
    { label: "Verify", command: "{run:verify}" },
    { label: "Verify one", command: "{run:verify} 0xabc LedgerToken" },
  ]);
  const findings = inspectManifest({ manifest, rootScripts: ROOT_SCRIPTS, shownWithArguments });
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /steps\[0\]\.command: runs "verify" bare, README\.md:9 passes it an argument/);
});
