// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { highestVersion, maxSatisfying } from "../lib/registry.mjs";
import { UnverifiableError } from "../lib/report.mjs";

const PUBLISHED = ["3.9.0", "3.24.0", "3.24.1", "3.25.76", "4.0.0-beta.1", "4.3.6", "0.4.0", "0.4.9", "0.5.0"];

test("a caret range takes the highest release that keeps its first non-zero part", () => {
  assert.equal(maxSatisfying(PUBLISHED, "^3.24.1"), "3.25.76");
  assert.equal(maxSatisfying(PUBLISHED, "^0.4.0"), "0.4.9");
  assert.equal(maxSatisfying(PUBLISHED, "^3.26.0"), undefined);
});

test("an exact version matches itself only", () => {
  assert.equal(maxSatisfying(PUBLISHED, "3.24.0"), "3.24.0");
  assert.equal(maxSatisfying(PUBLISHED, "3.24.2"), undefined);
});

test("any other range form is refused rather than guessed", () => {
  for (const range of [">=3.0.0", "~3.24.1", "3.x", "^3.24.1 || ^4.0.0"]) {
    assert.throws(() => maxSatisfying(PUBLISHED, range), UnverifiableError, range);
  }
});

test("versions compare by number, and pre-releases are never chosen", () => {
  assert.equal(highestVersion(["3.9.0", "3.10.0", "3.2.0"]), "3.10.0");
  assert.equal(highestVersion(["4.0.0-beta.1", "3.25.76"]), "3.25.76");
  assert.equal(highestVersion([]), undefined);
});
