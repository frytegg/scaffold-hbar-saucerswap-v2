// @ts-check
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ProbeConfigError, loadConfig } from "../src/config.mjs";

/** @type {string} */
let directory;

/**
 * @param {string} name
 * @param {string} content
 */
async function writeConfig(name, content) {
  const file = path.join(directory, name);
  await writeFile(file, content);
  return file;
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "route-probe-config-"));
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns the declared samples", async () => {
    const file = await writeConfig("valid.json", '{ "dynamicRouteSamples": { "/token/[id]": ["/token/1"] } }');
    assert.deepEqual(await loadConfig(file), { dynamicRouteSamples: { "/token/[id]": ["/token/1"] } });
  });

  it("rejects a sample list that is not a list of strings", async () => {
    const file = await writeConfig("not-a-list.json", '{ "dynamicRouteSamples": { "/token/[id]": "/token/1" } }');
    await assert.rejects(loadConfig(file), ProbeConfigError);
  });

  it("rejects a file without the samples key rather than probing with none", async () => {
    const file = await writeConfig("empty.json", "{}");
    await assert.rejects(loadConfig(file), ProbeConfigError);
  });

  it("keeps the parser's message as the cause of a syntax error", async () => {
    const file = await writeConfig("broken.json", "{ not json");
    await assert.rejects(loadConfig(file), error => {
      assert.ok(error instanceof ProbeConfigError);
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    });
  });

  it("reports a missing file as a configuration error", async () => {
    await assert.rejects(loadConfig(path.join(directory, "missing.json")), ProbeConfigError);
  });
});
