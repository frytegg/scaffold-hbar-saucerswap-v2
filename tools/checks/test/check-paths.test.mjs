// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { expandBraces, findPathFindings, pathCandidate } from "../check-paths.mjs";
import { parseMarkdown } from "../lib/markdown.mjs";

const TRACKED = [
  "README.md",
  "template.json",
  "packages/hardhat/.gitignore",
  "packages/hardhat/README.md",
  "packages/hardhat/hardhat.config.ts",
  "packages/hardhat/deploy/00_deploy_token.ts",
  "packages/nextjs/app/account/[id]/page.tsx",
];

/**
 * @param {string} markdown
 * @param {string} [file]
 * @param {string[]} [ignored] untracked paths the ignore rules cover
 */
function check(markdown, file = "README.md", ignored = []) {
  return findPathFindings({
    doc: parseMarkdown(file, markdown),
    tracked: TRACKED,
    ignoredAmong: paths => new Set(paths.filter(candidate => ignored.includes(candidate))),
  });
}

test("tracked files, tracked directories and bracketed route segments pass", () => {
  const doc =
    "See `packages/hardhat/deploy/`, `packages/hardhat/hardhat.config.ts`, `packages/nextjs/app/account/[id]/page.tsx`.";
  assert.deepEqual(check(doc), []);
});

test("a path that git does not track is refused with its line", () => {
  const findings = check("Intro.\n\nThe script is `packages/hardhat/deploy/99_deploy_missing.ts`.");
  assert.deepEqual(findings, [
    { file: "README.md", line: 3, message: "`packages/hardhat/deploy/99_deploy_missing.ts` is not a tracked path" },
  ]);
});

test("a bare file name resolves next to the doc, then anywhere in the tree", () => {
  assert.deepEqual(check("Edit `hardhat.config.ts`.", "packages/hardhat/README.md"), []);
  assert.deepEqual(check("Edit `hardhat.config.ts` and `00_deploy_token.ts`."), []);
  assert.equal(check("Edit `foundry.toml`.").length, 1);
});

test("placeholders and brace groups are expanded before the lookup", () => {
  assert.deepEqual(expandBraces("packages/{hardhat,nextjs}/README.md"), [
    "packages/hardhat/README.md",
    "packages/nextjs/README.md",
  ]);
  assert.deepEqual(check("Deploy scripts are `packages/hardhat/deploy/<nn>_<name>.ts`."), []);
  const findings = check("Both have `packages/{hardhat,nextjs}/README.md`.");
  assert.deepEqual(
    findings.map(finding => finding.message),
    ["`packages/nextjs/README.md` is not a tracked path"],
  );
});

test("an untracked path passes only when the ignore rules explain why it is absent", () => {
  const doc = "The key is stored in `packages/hardhat/.env`.";
  assert.deepEqual(check(doc, "README.md", ["packages/hardhat/.env"]), []);
  assert.equal(check(doc).length, 1);
});

test("the manifest is refused although it is tracked: the CLI deletes it from every scaffold", () => {
  const findings = check("Package managers: see `template.json`.");
  assert.match(findings[0].message, /is not in a scaffold/);
});

test("commands, URLs, package names, routes and price pairs are not read as paths", () => {
  for (const span of ["node tools/run.mjs", "https://example.org/a/b", "@scope/package", "/api/account", "HBAR/USD"]) {
    assert.equal(pathCandidate(span), undefined, span);
  }
});

test("every entry of a drawn directory tree has to exist somewhere in the tracked tree", () => {
  const tree = [
    "```text",
    "packages/",
    "├── hardhat/",
    "│   ├── deploy/            # deploy scripts",
    "│   └── scripts/",
    "└── nextjs/",
    "    └── app/<route>/page.tsx",
    "```",
  ].join("\n");
  const findings = check(tree);
  assert.deepEqual(findings, [
    { file: "README.md", line: 5, message: 'the tree shows "scripts", which no tracked path holds' },
  ]);
});

test("a tree entry the ignore rules explain, such as build output, passes", () => {
  const tree = "```\npackages/hardhat/\n└── artifacts/\n```";
  assert.equal(check(tree).length, 1);
  assert.deepEqual(check(tree, "README.md", ["packages/hardhat/artifacts"]), []);
});

test("an allowlisted path passes, and an allowlist entry nothing needs is reported", () => {
  const allow = "<!-- checks:allow\npaths: templates/blank-template docs/unused.md\n-->";
  const findings = check(`Branch \`templates/blank-template\`.\n\n${allow}`);
  assert.deepEqual(
    findings.map(finding => finding.message),
    ['allowlist entry "paths: docs/unused.md" excuses nothing in this file: remove it'],
  );
});
