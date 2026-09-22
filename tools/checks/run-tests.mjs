// @ts-check
import { readdirSync } from "node:fs";
import path from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { fileURLToPath } from "node:url";

// The test files are listed here because `node --test` takes no portable glob: Node 20 does not expand one, and
// not every shell a package script runs in does.
const testDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "test");
const files = readdirSync(testDir)
  .filter(name => name.endsWith(".test.mjs"))
  .map(name => path.join(testDir, name));

run({ files })
  .on("test:fail", () => {
    process.exitCode = 1;
  })
  .compose(spec)
  .pipe(process.stdout);
