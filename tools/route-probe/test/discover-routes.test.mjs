// @ts-check
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { RouteSampleError, discoverRoutes, matchesPattern } from "../src/discover-routes.mjs";

const APP_FILES = [
  "layout.tsx",
  "page.tsx",
  "not-found.tsx",
  "debug/page.tsx",
  "debug/_components/page.tsx",
  "(marketing)/about/page.jsx",
  "(marketing)/(legal)/terms/page.ts",
  "api/hedera/account/route.ts",
  "dashboard/@modal/login/page.tsx",
  "feed/(..)photo/page.tsx",
  "token/[id]/page.tsx",
  "docs/[...slug]/page.tsx",
  "shop/[[...filters]]/page.js",
  "drafts/notes.tsx",
];

/** @type {string} */
let appDirectory;

before(async () => {
  appDirectory = await mkdtemp(path.join(os.tmpdir(), "route-probe-app-"));
  for (const file of APP_FILES) {
    const target = path.join(appDirectory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "");
  }
});

after(async () => {
  await rm(appDirectory, { recursive: true, force: true });
});

describe("discoverRoutes", () => {
  it("lists static page routes, sorted, with route groups folded away", async () => {
    const { paths } = await discoverRoutes(appDirectory);
    assert.deepEqual(paths, ["/", "/about", "/debug", "/terms"]);
  });

  it("ignores route handlers, private folders, parallel slots, intercepting routes and folders without a page", async () => {
    const { paths, unsampled } = await discoverRoutes(appDirectory);
    const everything = [...paths, ...unsampled].join(" ");
    for (const fragment of ["api", "_components", "@modal", "login", "photo", "drafts"]) {
      assert.ok(!everything.includes(fragment), `"${fragment}" must not appear in ${everything}`);
    }
  });

  it("reports every dynamic route that has no sample instead of probing a made-up URL", async () => {
    const { unsampled } = await discoverRoutes(appDirectory);
    assert.deepEqual(unsampled, ["/docs/[...slug]", "/shop/[[...filters]]", "/token/[id]"]);
  });

  it("probes a dynamic route through its declared samples", async () => {
    const { paths, unsampled } = await discoverRoutes(appDirectory, {
      "/token/[id]": ["/token/0.0.1234", "/token/0.0.5678"],
      "/shop/[[...filters]]": ["/shop"],
    });
    assert.deepEqual(paths, ["/", "/about", "/debug", "/shop", "/terms", "/token/0.0.1234", "/token/0.0.5678"]);
    assert.deepEqual(unsampled, ["/docs/[...slug]"]);
  });

  it("still reports a dynamic route whose sample list is empty", async () => {
    const { unsampled } = await discoverRoutes(appDirectory, { "/token/[id]": [] });
    assert.ok(unsampled.includes("/token/[id]"));
  });

  it("rejects samples for a route the app does not have, so stale configuration cannot hide", async () => {
    await assert.rejects(discoverRoutes(appDirectory, { "/removed/[id]": ["/removed/1"] }), RouteSampleError);
    await assert.rejects(discoverRoutes(appDirectory, { "/debug": ["/debug"] }), RouteSampleError);
  });

  it("rejects a sample that does not match its route", async () => {
    await assert.rejects(discoverRoutes(appDirectory, { "/token/[id]": ["/tokens/1"] }), RouteSampleError);
  });

  it("fails loudly when the app directory does not exist", async () => {
    await assert.rejects(discoverRoutes(path.join(appDirectory, "missing")), { code: "ENOENT" });
  });
});

describe("matchesPattern", () => {
  it("binds one segment per dynamic segment", () => {
    assert.equal(matchesPattern("/token/[id]", "/token/42"), true);
    assert.equal(matchesPattern("/token/[id]", "/token"), false);
    assert.equal(matchesPattern("/token/[id]", "/token/42/holders"), false);
    assert.equal(matchesPattern("/token/[id]/holders", "/token/42/holders"), true);
  });

  it("requires at least one segment for a catch-all and none for an optional catch-all", () => {
    assert.equal(matchesPattern("/docs/[...slug]", "/docs/a/b"), true);
    assert.equal(matchesPattern("/docs/[...slug]", "/docs"), false);
    assert.equal(matchesPattern("/shop/[[...filters]]", "/shop"), true);
    assert.equal(matchesPattern("/shop/[[...filters]]", "/shop/a/b"), true);
  });

  it("rejects a path that is not absolute", () => {
    assert.equal(matchesPattern("/token/[id]", "token/42"), false);
  });
});
