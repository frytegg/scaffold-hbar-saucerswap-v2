// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { sliceCliBundle } from "../lib/cli-bundle.mjs";
import { UnverifiableError } from "../lib/report.mjs";
import { readFixture } from "./support.mjs";

// A stand-in with the anchors of the published bundle and bodies of its own, so that no network is needed here.
const BUNDLE = readFixture("cli-bundle.fixture");

test("the sliced pieces are callable and carry what the bundle declares", () => {
  const slices = sliceCliBundle(BUNDLE);
  assert.equal(slices.rewriteText("before and before"), "after and after");
  assert.equal(slices.transformScript("lint", "npm"), "LINT");
  assert.deepEqual([...slices.textExtensions], [".md", ".json"]);
  assert.deepEqual(slices.extraFileNames, [".gitignore", ".prettierignore"]);
  assert.deepEqual(slices.removedInNpmMode, [".husky"]);
  assert.equal(slices.skippedDir, ".harness");
  assert.match(slices.schemaSource, /^const EnvVarSchema[\s\S]*\}\)\);$/);
});

test("a bundle without one of the anchors is refused with the anchor named: the CLI changed", () => {
  const renamed = BUNDLE.replace("function replaceYarnReference(content) {", "function rewriteReferences(content) {");
  assert.throws(
    () => sliceCliBundle(renamed),
    error =>
      error instanceof UnverifiableError &&
      /create-scaffold-hbar changed: "function replaceYarnReference/.test(error.message),
  );
});

test("a bundle whose file walker names no extra file is refused rather than read as an empty list", () => {
  const silent = BUNDLE.replace(/entry\.name !== /g, "entry.base !== ");
  assert.throws(() => sliceCliBundle(silent), UnverifiableError);
});
