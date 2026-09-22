// Run with: node --test tools/gate/routes.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { collectTargets, judgeAnswer } from "./routes.mjs";

/** @typedef {import("./routes.mjs").Target} Target */

/** @type {string[]} */
const buildDirs = [];

/**
 * @param {Record<string, string>} appRoutes app-path-routes-manifest.json: entry to route
 * @param {Record<string, { srcRoute: string | null }>} [prerenderedRoutes] the "routes" of prerender-manifest.json
 * @returns {string} a build directory holding both manifests
 */
function buildWith(appRoutes, prerenderedRoutes = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gate-routes-"));
  buildDirs.push(dir);
  writeFileSync(path.join(dir, "app-path-routes-manifest.json"), JSON.stringify(appRoutes));
  writeFileSync(path.join(dir, "prerender-manifest.json"), JSON.stringify({ routes: prerenderedRoutes }));
  return dir;
}

after(() => {
  for (const dir of buildDirs) rmSync(dir, { recursive: true, force: true });
});

test("every static page and handler of the build is requested, the not-found page is not", () => {
  const dir = buildWith({
    "/page": "/",
    "/debug/page": "/debug",
    "/_not-found/page": "/_not-found",
    "/api/account/route": "/api/account",
  });
  assert.deepEqual(collectTargets(dir, []), {
    targets: [
      { route: "/", kind: "page", maxStatus: 399 },
      { route: "/debug", kind: "page", maxStatus: 399 },
      { route: "/api/account", kind: "handler", maxStatus: 499 },
    ],
    problems: [],
  });
});

test("a dynamic page is requested once per prerendered instance", () => {
  const dir = buildWith(
    { "/token/[id]/page": "/token/[id]" },
    { "/token/1": { srcRoute: "/token/[id]" }, "/token/2": { srcRoute: "/token/[id]" }, "/debug": { srcRoute: null } },
  );
  assert.deepEqual(
    collectTargets(dir, []).targets.map(target => target.route),
    ["/token/1", "/token/2"],
  );
});

test("a dynamic page that nothing can instantiate is reported instead of being skipped", () => {
  const dir = buildWith({ "/token/[id]/page": "/token/[id]" });
  const { targets, problems } = collectTargets(dir, []);
  assert.deepEqual(targets, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^\/token\/\[id\]: no prerendered instance/);
});

test("an extra route instantiates a dynamic page, catch-all and optional catch-all included", () => {
  const dir = buildWith({
    "/token/[id]/page": "/token/[id]",
    "/docs/[...slug]/page": "/docs/[...slug]",
    "/shop/[[...filters]]/page": "/shop/[[...filters]]",
  });
  const extras = ["/token/7", "/docs/a/b", "/shop"];
  const { targets, problems } = collectTargets(dir, extras);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    targets,
    extras.map(route => ({ route, kind: "extra", maxStatus: 399 })),
  );
});

test("an extra route does not instantiate a dynamic page of another depth", () => {
  const dir = buildWith({ "/token/[id]/page": "/token/[id]" });
  assert.equal(collectTargets(dir, ["/token/1/holders"]).problems.length, 1);
});

test("a handler covered by an extra route with a query string is not requested bare", () => {
  const dir = buildWith({ "/api/account/route": "/api/account" });
  assert.deepEqual(collectTargets(dir, ["/api/account?evm=0x01"]).targets, [
    { route: "/api/account?evm=0x01", kind: "extra", maxStatus: 399 },
  ]);
});

test("a missing build is an error that names the file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gate-routes-"));
  buildDirs.push(dir);
  assert.throws(() => collectTargets(dir, []), /app-path-routes-manifest\.json: is the production build missing\?/);
});

test("a handler may refuse a bare request but must not crash", () => {
  /** @type {Target} */
  const handler = { route: "/api/account", kind: "handler", maxStatus: 499 };
  assert.equal(judgeAnswer(handler, 400, "application/json", '{"error":"Missing or invalid EVM address"}'), null);
  assert.equal(judgeAnswer(handler, 502, "application/json", "{}"), "/api/account: status 502, expected at most 499");
});

test("a page must render text; a short JSON answer and a redirect are not pages", () => {
  /** @type {Target} */
  const page = { route: "/debug", kind: "page", maxStatus: 399 };
  const shell =
    "<html><head><style>p{}</style><script>let a = 'long enough to count if scripts counted';</script></head><body><p>Hi</p></body></html>";
  assert.equal(
    judgeAnswer(page, 200, "text/html; charset=utf-8", shell),
    "/debug: 2 characters of visible text, expected at least 20",
  );
  assert.equal(judgeAnswer(page, 200, "text/html", "<main>Debug contracts: nothing deployed yet</main>"), null);
  assert.equal(judgeAnswer(page, 307, "text/html", ""), null);
  assert.equal(
    judgeAnswer(page, 404, "text/html", "<main>This page could not be found</main>"),
    "/debug: status 404, expected at most 399",
  );
  /** @type {Target} */
  const extra = { route: "/api/account?evm=0x01", kind: "extra", maxStatus: 399 };
  assert.equal(judgeAnswer(extra, 200, "application/json", '{"accountId":null}'), null);
});
