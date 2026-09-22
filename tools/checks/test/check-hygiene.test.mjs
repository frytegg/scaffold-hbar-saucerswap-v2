// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { check, inspectHistory, inspectLicence, inspectTree } from "../check-hygiene.mjs";
import { YARN } from "../lib/package-manager.mjs";
import { readText } from "../lib/repo.mjs";
import { REPO_ROOT } from "./support.mjs";

const FILE = "100644";

/** @param {Partial<import("../check-hygiene.mjs").TreeEntry> & { file: string }} entry */
function entry({ file, mode = FILE, size = 100 }) {
  return { file, mode, size };
}

test("dotenv files are refused at any depth, inside the hosts' kit too; the example template is not one", () => {
  const tree = [".env", "packages/app/.env.local", ".claude/.env", "packages/app/.env.example", "docs/environment.md"];
  assert.deepEqual(
    inspectTree(tree.map(file => entry({ file }))).map(finding => finding.file),
    [".env", "packages/app/.env.local", ".claude/.env"],
  );
});

test("a symbolic link is refused, except those the skills step adds to the hosts' kit", () => {
  const findings = inspectTree([
    entry({ file: "docs/guide.md", mode: "120000" }),
    entry({ file: ".claude/skills/hedera", mode: "120000" }),
  ]);
  assert.deepEqual(
    findings.map(finding => [finding.file, finding.message]),
    [["docs/guide.md", "symbolic link: it becomes a text file on Windows"]],
  );
});

test("a file over 1 MB is refused unless it is a lockfile or the vendored package-manager release", () => {
  const big = 2 * 1024 * 1024;
  const tree = [
    entry({ file: "docs/demo.mp4", size: big }),
    entry({ file: "package-lock.json", size: big }),
    entry({ file: `.${YARN}/releases/release.cjs`, size: big }),
  ];
  assert.deepEqual(
    inspectTree(tree).map(finding => finding.file),
    ["docs/demo.mp4"],
  );
});

test("configuration of AI tools outside the hosts' kit is refused, nested or not, and so are personal settings", () => {
  const tree = [
    ".cursor/rules/style.mdc",
    "web/.windsurfrules",
    "web/.github/skills/x/SKILL.md",
    ".claude/settings.local.json",
  ];
  const kit = [".claude/agents/reviewer.md", ".agents/skills/solidity/SKILL.md", "AGENTS.md", "CLAUDE.md"];
  const findings = inspectTree([...tree, ...kit].map(file => entry({ file })));
  assert.deepEqual(findings.map(finding => finding.file).sort(), [...tree].sort());
});

test("the licence of this repository passes; a missing, reworded or stripped one is refused", () => {
  const licence = readText(REPO_ROOT, "LICENCE");
  assert.deepEqual(inspectLicence(new Map([["LICENCE", licence]])), []);
  assert.match(inspectLicence(new Map())[0].message, /no licence file/);
  const reworded = licence.replace("without restriction", "with some restrictions");
  assert.match(inspectLicence(new Map([["LICENCE", reworded]]))[0].message, /not the unmodified MIT text/);
  const stripped = licence.replace(/^Copyright \(c\) \d+ BuidlGuidl\n/m, "");
  assert.match(inspectLicence(new Map([["LICENCE", stripped]]))[0].message, /notice of BuidlGuidl is missing/);
});

test("history output is read per commit, and only dotenv files are kept", () => {
  const log = [
    "commit 1111111aaaa",
    "",
    "README.md",
    "packages/app/.env",
    "commit 2222222bbbb",
    "",
    ".env.example",
  ].join("\n");
  assert.deepEqual(inspectHistory(log), [
    {
      file: "packages/app/.env",
      message: "added by commit 1111111: history keeps it for every clone, rotate what it held",
    },
  ]);
});

/**
 * @param {(git: (args: string[], input?: string) => string, repo: string) => void} build
 * @returns {Promise<import("../lib/report.mjs").CheckResult>} the check run on a throwaway repository
 */
async function checkFixtureRepo(build) {
  const repo = mkdtempSync(path.join(os.tmpdir(), "check-hygiene-"));
  /** @type {(args: string[], input?: string) => string} */
  const git = (args, input) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", ...args], {
      encoding: "utf8",
      input,
      stdio: "pipe",
    });
  try {
    git(["init", "--quiet", "-b", "main"]);
    writeFileSync(path.join(repo, "LICENCE"), readText(REPO_ROOT, "LICENCE"));
    git(["add", "LICENCE"]);
    git(["commit", "--quiet", "-m", "chore: first"]);
    build(git, repo);
    return await check.run({ repoRoot: repo, allowOffline: false });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test("a dotenv file that was committed and then removed is still found, on a branch too", async () => {
  const result = await checkFixtureRepo((git, repo) => {
    git(["checkout", "--quiet", "-b", "experiment"]);
    writeFileSync(path.join(repo, ".env"), "DEPLOYER_KEY=not-a-real-key\n");
    git(["add", "--force", ".env"]);
    git(["commit", "--quiet", "-m", "chore: oops"]);
    git(["rm", "--quiet", ".env"]);
    git(["commit", "--quiet", "-m", "chore: remove it"]);
    git(["checkout", "--quiet", "main"]);
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].file, ".env");
  assert.match(result.findings[0].message, /^added by commit [0-9a-f]{7}: history keeps it/);
});

test("sizes and modes are read from the index, so a staged link or a large blob is refused before it is committed", async () => {
  const result = await checkFixtureRepo((git, repo) => {
    writeFileSync(path.join(repo, "demo.bin"), Buffer.alloc(1536 * 1024));
    git(["add", "demo.bin"]);
    const target = git(["hash-object", "-w", "--stdin"], "LICENCE").trim();
    git(["update-index", "--add", "--cacheinfo", `120000,${target},licence-link`]);
  });
  assert.deepEqual(
    result.findings.map(finding => [finding.file, finding.message]),
    [
      ["demo.bin", "1.5 MB: over the 1 MB limit for a tracked file"],
      ["licence-link", "symbolic link: it becomes a text file on Windows"],
    ],
  );
});
