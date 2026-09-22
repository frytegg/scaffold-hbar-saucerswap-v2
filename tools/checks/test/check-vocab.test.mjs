// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectDocWording, inspectManifestWording } from "../check-vocab.mjs";
import { parseMarkdown } from "../lib/markdown.mjs";
import { YARN } from "../lib/package-manager.mjs";
import { fixtureDoc, linesOf } from "./support.mjs";

const findings = inspectDocWording(fixtureDoc("wording.markdown"));
const bareNames = findings.filter(finding => finding.message.startsWith("a package manager is named"));

test("a package manager named in prose is refused", () => {
  assert.ok(linesOf(bareNames).includes(3));
});

test("an exact script command passes, inline or fenced, with or without a shell comment", () => {
  assert.equal(linesOf(bareNames).includes(5), false);
  assert.equal(linesOf(bareNames).includes(14), false);
});

test("a command is refused once it is more than the script name", () => {
  assert.deepEqual(linesOf(bareNames), [3, 7, 15]);
});

test("the install command passes with the lockfile flag the rewrite strips, and with no other", () => {
  const doc = parseMarkdown("README.md", `\`${YARN} install --immutable\`\n\n\`${YARN} install --check-cache\``);
  assert.deepEqual(linesOf(inspectDocWording(doc)), [3]);
});

test("each word the Hedera docs avoid is refused with its replacement", () => {
  const avoided = findings.filter(finding => !bareNames.includes(finding));
  assert.deepEqual(
    avoided.map(({ line, message }) => [line, message.split(":")[0]]),
    [
      [9, '"blockchain"'],
      [9, '"Hbar"'],
      [9, '"HBARs"'],
      [11, '"EVM alias"'],
      [11, '"@hashgraph/sdk"'],
    ],
  );
});

test("correct spellings that contain an avoided word pass", () => {
  assert.equal(
    findings.some(finding => finding.line === 18),
    false,
  );
});

test("manifest texts are held to the same wording, except the package-manager enum values", () => {
  const manifest = [
    "{",
    `  "packageManager": ["${YARN}", "npm"],`,
    `  "text": "Run ${YARN} dev on this blockchain"`,
    "}",
  ].join("\n");
  assert.deepEqual(linesOf(inspectManifestWording(manifest)), [3, 3]);
});
