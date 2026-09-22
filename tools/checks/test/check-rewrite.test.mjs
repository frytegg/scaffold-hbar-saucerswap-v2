// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectPackageManifest, inspectTextRewrite } from "../check-rewrite.mjs";
import { YARN } from "../lib/package-manager.mjs";
import { linesOf, readFixture } from "./support.mjs";

// The ".after" fixtures are the output of the rewrite function of create-scaffold-hbar 0.4.0 on the ".before" ones.
const SCRIPTS = new Set(["dev", "lint:strict", "deploy"]);

/**
 * @param {string} name
 * @param {string} [file]
 */
function inspectFixture(name, file = "README.md") {
  const before = readFixture(`${name}.before.markdown`);
  return inspectTextRewrite({ file, before, after: readFixture(`${name}.after.markdown`), scripts: SCRIPTS });
}

test("a doc whose only changes are conversions of known scripts and of the install command passes", () => {
  assert.deepEqual(inspectFixture("rewrite-clean"), []);
});

test("the same conversions are refused when the script is not a root script", () => {
  const before = readFixture("rewrite-clean.before.markdown");
  const after = readFixture("rewrite-clean.after.markdown");
  const findings = inspectTextRewrite({ file: "README.md", before, after, scripts: new Set(["dev"]) });
  assert.deepEqual(linesOf(findings), [7]);
});

test("each known kind of damage is reported on the line that holds it", () => {
  const findings = inspectFixture("rewrite-damaged");
  const damage = findings.filter(finding => finding.message.startsWith("after the rewrite"));
  assert.deepEqual(linesOf(damage), [3, 4, 6, 12]);
  assert.match(damage[0].message, /names one twice/);
  assert.match(damage[1].message, /lockfile got a name/);
  assert.match(damage[2].message, /`create` script/);
  assert.match(damage[3].message, /doubled `run`/);
});

test("prose and option values the rewrite mangles are refused as unclean conversions", () => {
  const unclean = inspectFixture("rewrite-damaged").filter(finding => finding.message.startsWith("not a clean"));
  assert.deepEqual(linesOf(unclean), [3, 4, 6, 10, 12]);
});

test("a converted command that keeps a flag is refused: the flag would not reach the script", () => {
  const flagged = inspectFixture("rewrite-damaged").filter(finding => finding.message.includes("never reaches"));
  assert.deepEqual(linesOf(flagged), [8]);
});

test("a changed line count is refused: a line that ends in the package manager's name absorbs the next one", () => {
  const findings = inspectFixture("rewrite-joined");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
  assert.match(findings[0].message, /joins lines \(6 become 4\)/);
});

test("any change to a source file is refused, even a clean conversion", () => {
  const before = `// start it with: ${YARN} dev\nexport const port = 3000;\n`;
  const after = "// start it with: npm run dev\nexport const port = 3000;\n";
  const findings = inspectTextRewrite({ file: "packages/app/config.ts", before, after, scripts: SCRIPTS });
  assert.deepEqual(linesOf(findings), [1]);
  assert.match(findings[0].message, /alters this source line/);
});

test("the manifest's package-manager values may change; its texts may not", () => {
  const before = `{\n  "packageManager": ["${YARN}", "npm"],\n  "description": "Made for ${YARN} users"\n}`;
  const after = '{\n  "packageManager": ["npm", "npm"],\n  "description": "Made for npm run users"\n}';
  const findings = inspectTextRewrite({ file: "template.json", before, after, scripts: SCRIPTS });
  assert.deepEqual(linesOf(findings), [3]);
});

test("a workflow's cache key may change; a step that keeps a flag is still refused", () => {
  const before = `    cache: ${YARN}\n    run: ${YARN} lint:strict\n    run: ${YARN} deploy --network testnet\n`;
  const after = "    cache: npm\n    run: npm run lint:strict\n    run: npm run deploy --network testnet\n";
  const findings = inspectTextRewrite({ file: ".github/workflows/ci.yml", before, after, scripts: SCRIPTS });
  assert.deepEqual(linesOf(findings), [3]);
  assert.match(findings[0].message, /never reaches the script/);
});

/** Stands in for the CLI: the scripts under test are already spelled the way its conversion leaves them. */
const identity = {
  rewriteText: (/** @type {string} */ text) => text,
  transformScript: (/** @type {string} */ script) => script,
};

test("a converted package script is refused when its flag precedes the separator", () => {
  const manifest = {
    name: "root",
    scripts: { lint: "eslint", strict: "npm run lint --max-warnings=0", safe: "npm run lint -- --fix" },
  };
  const findings = inspectPackageManifest({
    file: "package.json",
    manifest,
    convertsScripts: true,
    workspaceScripts: new Map(),
    rewriter: identity,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /script "strict".*--max-warnings=0 never reaches the script/);
});

test("a converted package script is refused when it calls a script its target does not have", () => {
  const manifest = {
    name: "root",
    scripts: { compile: "npm run compile -w @sh/contracts --", build: "npm run hardhat compile" },
  };
  const workspaceScripts = new Map([["@sh/contracts", new Set(["compile"])]]);
  const findings = inspectPackageManifest({
    file: "package.json",
    manifest,
    convertsScripts: true,
    workspaceScripts,
    rewriter: identity,
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /script "build".*"hardhat" is not a script there/);
});

test("a script run with npm's --prefix is looked up in that package, and the option is not a swallowed flag", () => {
  const manifest = {
    name: "root",
    scripts: {
      probe: "npm ci --prefix tools/probe && npm run browsers --prefix tools/probe && node tools/probe/cli.mjs",
      typo: "npm run browser --prefix tools/probe",
      nowhere: "npm run browsers --prefix=tools/missing",
      flagged: "npm run browsers --prefix tools/probe --with-deps",
    },
  };
  const findings = inspectPackageManifest({
    file: "package.json",
    manifest,
    convertsScripts: true,
    workspaceScripts: new Map(),
    scriptsByDir: new Map([["tools/probe", new Set(["browsers"])]]),
    rewriter: identity,
  });
  assert.deepEqual(
    findings.map(finding => finding.message.replace(/ becomes .*?"(,|:)/, "$1")),
    [
      'script "typo", and "browser" is not a script there',
      'script "nowhere", and "browsers" is not a script there',
      'script "flagged": --with-deps never reaches the script',
    ],
  );
});

test("a manifest whose scripts the CLI leaves alone keeps its package-manager field in view of the text rewrite", () => {
  const rewriter = {
    rewriteText: (/** @type {string} */ text) => text.replaceAll(`${YARN}@`, "npm@"),
    transformScript: () => assert.fail("the CLI converts no script of this manifest"),
  };
  const manifest = { name: "tool", packageManager: `${YARN}@3.2.3`, scripts: { probe: "node probe.mjs" } };
  const findings = inspectPackageManifest({
    file: "tools/probe/package.json",
    manifest,
    convertsScripts: false,
    workspaceScripts: new Map(),
    rewriter,
  });
  assert.deepEqual(
    findings.map(finding => finding.message),
    [`the rewrite alters ""packageManager": "${YARN}@3.2.3""`],
  );
});

test("a package manifest is refused when the text rewrite reaches anything the script conversion left", () => {
  const rewriter = {
    ...identity,
    rewriteText: (/** @type {string} */ text) => text.replaceAll("legacy-tool", "npm run legacy-tool"),
  };
  const manifest = {
    name: "root",
    scripts: { audit: "legacy-tool audit" },
    devDependencies: { "legacy-tool": "1.0.0" },
  };
  const findings = inspectPackageManifest({
    file: "package.json",
    manifest,
    convertsScripts: true,
    workspaceScripts: new Map(),
    rewriter,
  });
  assert.equal(
    findings.some(finding => finding.message.includes('the rewrite alters ""legacy-tool": "1.0.0""')),
    true,
  );
  assert.equal(
    findings.some(finding => finding.message.includes("then mangles it")),
    true,
  );
});
