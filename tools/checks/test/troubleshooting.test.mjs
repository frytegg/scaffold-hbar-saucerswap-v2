// @ts-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// docs/troubleshooting.md promises one thing: every string it is keyed by was captured from Hedera testnet, its
// relay or a browser wallet, and the entry names the file holding it. A promise nothing re-reads is a promise that
// rots, and this page is the one a judge can falsify by opening a single file.

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const PAGE = "docs/troubleshooting.md";
const page = readFileSync(path.join(repoRoot, PAGE), "utf8");

/** Each `##` entry: the string it is keyed by, and the files its "Captured in" line names. */
function entries() {
  return page
    .split(/^## /m)
    .slice(1)
    .filter(entry => entry.startsWith("`"))
    .map(entry => {
      const heading = entry.split("\n", 1)[0];
      // The key is the first backticked span of the heading; anything after it is context for a human.
      const string = heading.split("`")[1];
      const captured = entry.split("**Captured in**")[1] ?? "";
      const named = [...captured.matchAll(/`([^`]+\.(?:json|png))`/g)].map(([, name]) => name);
      // A bare file name means the directory of the one before it, as prose does.
      let directory = "";
      const files = named.map(name => {
        if (name.includes("/")) {
          directory = name.slice(0, name.lastIndexOf("/"));
          return name;
        }
        return `${directory}/${name}`;
      });
      return { string, files };
    });
}

test("the page is keyed by strings, and each entry names where its string was captured", () => {
  const all = entries();
  assert.ok(all.length >= 10, `only ${all.length} entries: the page is meant to cover what a developer actually hits`);
  for (const { string, files } of all) {
    assert.ok(string.length > 6, `"${string}" is too short to be an error string`);
    assert.ok(files.length > 0, `"${string}" names no file it was captured in`);
  }
});

test("every string of the page is in a file the page names", () => {
  for (const { string, files } of entries()) {
    const searchable = files.filter(file => !file.endsWith(".png"));
    if (searchable.length === 0) continue; // a picture is evidence a reader looks at, not text to search
    const holders = searchable.filter(file => readFileSync(path.join(repoRoot, file), "utf8").includes(string));
    assert.ok(holders.length > 0, `"${string}" is in none of ${searchable.join(", ")}`);
  }
});

test("a string the captures do not hold fails this test", () => {
  const invented = "execution reverted: THIS_WAS_NEVER_CAPTURED";
  const file = "packages/nextjs/lib/hedera/__tests__/fixtures/rpc/call-mint-not-estimable.json";
  assert.equal(readFileSync(path.join(repoRoot, file), "utf8").includes(invented), false);
});
