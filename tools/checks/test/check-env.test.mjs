// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareEnvSets, findEnvReads, readClaim, readDocEnv } from "../check-env.mjs";
import { parseMarkdown } from "../lib/markdown.mjs";

const CODE = [
  'const KEY_ENV = "DEPLOYER_KEY_ENCRYPTED";',
  'const rpcUrl = process.env.LEDGER_RPC_URL || "https://testnet.example";',
  "const encrypted = process.env[KEY_ENV];",
  'const projectId = process.env["WALLET_PROJECT_ID"] ?? "";',
  'process.env.RUNTIME_KEY = "set by the wrapper";',
  "const runtimeKey = process.env.RUNTIME_KEY;",
  "const port = process.env.PORT;",
  'const strict = process.env.STRICT_MODE === "true";',
].join("\n");

const README = [
  "# App",
  "",
  "## Environment variables",
  "",
  "| Variable | Required? | Meaning |",
  "| --- | --- | --- |",
  "| `LEDGER_RPC_URL` | yes | JSON-RPC endpoint |",
  "| `WALLET_PROJECT_ID` | no | wallet pairing |",
  "| `DEPLOYER_KEY_ENCRYPTED` | no | written by the account script |",
  "| `STRICT_MODE` | no | fail on warnings |",
  "",
  "## Troubleshooting",
  "",
  "`INSUFFICIENT_PAYER_BALANCE` means the account needs funds.",
].join("\n");

const constants = new Map([["KEY_ENV", "DEPLOYER_KEY_ENCRYPTED"]]);

/** @param {Partial<import("../check-env.mjs").EnvSets>} overrides */
function compare(overrides = {}) {
  return compareEnvSets({
    ...findEnvReads("config.ts", CODE, constants),
    setByScripts: new Set(),
    examples: new Map(
      ["LEDGER_RPC_URL", "WALLET_PROJECT_ID", "DEPLOYER_KEY_ENCRYPTED", "STRICT_MODE"].map((name, index) => [
        name,
        { file: ".env.example", line: index + 1 },
      ]),
    ),
    ...readDocEnv(parseMarkdown("README.md", README.replace("| yes |", "| no |"))),
    manifest: undefined,
    ...overrides,
  });
}

test("reads are found in dotted, quoted and constant-indexed form, with their fallbacks", () => {
  const { reads, unresolved } = findEnvReads("config.ts", CODE, constants);
  assert.deepEqual(unresolved, []);
  assert.deepEqual(
    reads.map(({ name, line, assigned, hasFallback }) => [name, line, assigned, hasFallback]),
    [
      ["LEDGER_RPC_URL", 2, false, true],
      ["DEPLOYER_KEY_ENCRYPTED", 3, false, false],
      ["WALLET_PROJECT_ID", 4, false, true],
      ["RUNTIME_KEY", 5, true, false],
      ["RUNTIME_KEY", 6, false, false],
      ["PORT", 7, false, false],
      ["STRICT_MODE", 8, false, false],
    ],
  );
});

test("a computed variable name that no constant explains is refused", () => {
  const { unresolved } = findEnvReads("config.ts", "const value = process.env[prefix + name];", constants);
  assert.deepEqual(unresolved, [{ file: "config.ts", line: 1 }]);
});

test("three agreeing sets pass; platform variables and variables the code sets itself need no entry", () => {
  assert.deepEqual(compare(), []);
});

test("a variable read in code but absent from every .env.example is refused", () => {
  const examples = new Map([["LEDGER_RPC_URL", { file: ".env.example", line: 1 }]]);
  const findings = compare({ examples });
  assert.ok(
    findings.some(
      ({ file, line, message }) =>
        file === "config.ts" && line === 8 && message === "STRICT_MODE is read here but no .env.example lists it",
    ),
  );
});

test("an .env.example key that no code reads is refused at its line", () => {
  const examples = new Map([["LEGACY_API_KEY", { file: "packages/app/.env.example", line: 4 }]]);
  const findings = compare({ examples });
  assert.ok(
    findings.some(
      ({ file, line, message }) =>
        file === "packages/app/.env.example" &&
        line === 4 &&
        message === "LEGACY_API_KEY is listed here but no code reads it",
    ),
  );
});

test("a variable the docs never name is refused; a status code in another section is not taken for one", () => {
  const messages = compare({ named: new Set(["LEDGER_RPC_URL"]) }).map(finding => finding.message);
  assert.ok(messages.includes("STRICT_MODE is used here but no doc names it"));
  assert.equal(readDocEnv(parseMarkdown("README.md", README)).declared.has("INSUFFICIENT_PAYER_BALANCE"), false);
});

test("a variable documented as such but read nowhere is refused", () => {
  const doc = parseMarkdown("README.md", "## Environment variables\n\n`GHOST_TOKEN` enables nothing.");
  const findings = compare({
    ...readDocEnv(doc),
    named: new Set([...readDocEnv(parseMarkdown("README.md", README)).named, "GHOST_TOKEN"]),
  });
  assert.deepEqual(findings, [
    { file: "README.md", line: 3, message: "GHOST_TOKEN is documented as a variable, but nothing reads or lists it" },
  ]);
});

test('"required" is refused when the code falls back to a default', () => {
  const findings = compare(readDocEnv(parseMarkdown("README.md", README)));
  assert.deepEqual(findings, [
    { file: "README.md", line: 7, message: "LEDGER_RPC_URL is called required, but the code falls back to a default" },
  ]);
});

test("the manifest has to list the same variables as the examples and make the same claims as the docs", () => {
  const manifest = new Map([
    ["LEDGER_RPC_URL", readClaim("packages/app/.env, optional. JSON-RPC endpoint.")],
    ["WALLET_PROJECT_ID", readClaim("Required for wallet pairing.")],
    ["DEPLOYER_KEY_ENCRYPTED", readClaim("Written by the account script.")],
    ["OLD_VARIABLE", undefined],
  ]);
  const messages = compare({ manifest }).map(finding => finding.message);
  assert.deepEqual(messages.sort(), [
    "STRICT_MODE is missing from envVars in template.json",
    "WALLET_PROJECT_ID is called required, but the code falls back to a default",
    "WALLET_PROJECT_ID is optional here and required in template.json",
    "envVars lists OLD_VARIABLE, no .env.example does",
  ]);
});
