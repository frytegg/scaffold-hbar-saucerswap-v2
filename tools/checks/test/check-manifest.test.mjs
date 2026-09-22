// @ts-check
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { buildSchema, droppedKeys, validateManifest } from "../check-manifest.mjs";
import { sliceCliBundle } from "../lib/cli-bundle.mjs";
import { REPO_ROOT, readFixture } from "./support.mjs";

/** @returns {{ z?: unknown, skip: string | false }} zod from the frontend workspace, where an install puts it */
function findZod() {
  try {
    return { z: createRequire(path.join(REPO_ROOT, "packages", "nextjs", "package.json"))("zod").z, skip: false };
  } catch (error) {
    return { skip: `zod is not installed: ${error instanceof Error ? error.message : error}` };
  }
}

const { z, skip } = findZod();
const schemaSource = sliceCliBundle(readFixture("cli-bundle.fixture")).schemaSource;

/** @param {unknown} manifest */
function validate(manifest) {
  return validateManifest("as committed", JSON.stringify(manifest), buildSchema(schemaSource, z));
}

test("a manifest the schema reads back unchanged passes", { skip }, () => {
  const manifest = { name: "base", "create-scaffold-hbar": { envVars: [{ key: "RPC_URL", description: "optional" }] } };
  assert.deepEqual(validate(manifest), []);
});

test("a misspelt key is refused: the schema would drop it without a word", { skip }, () => {
  const findings = validate({ name: "base", "create-scaffold-hbar": { enVars: [] } });
  assert.deepEqual(
    findings.map(finding => finding.message),
    ['as committed: the CLI ignores "create-scaffold-hbar.enVars": not a key of its schema'],
  );
});

test("a schema violation is reported with the path of the offending value", { skip }, () => {
  const findings = validate({ name: "base", "create-scaffold-hbar": { envVars: [{ name: "RPC_URL", value: "" }] } });
  assert.equal(findings.length, 2);
  assert.match(findings[0].message, /^as committed: create-scaffold-hbar\.envVars\.0\.key: /);
  assert.match(findings[1].message, /^as committed: create-scaffold-hbar\.envVars\.0\.description: /);
});

test("text that is no longer JSON after a rewrite is refused, not thrown", { skip }, () => {
  const findings = validateManifest("after the npm-mode rewrite", '{ "name": "base", }', buildSchema(schemaSource, z));
  assert.match(findings[0].message, /^after the npm-mode rewrite: not valid JSON/);
});

test("dropped keys are located at any depth, inside arrays too", () => {
  const input = { outro: { sections: [{ title: "Next", stepz: [] }] } };
  const parsed = { outro: { sections: [{ title: "Next" }] } };
  assert.deepEqual(droppedKeys(input, parsed), ["outro.sections[0].stepz"]);
});
