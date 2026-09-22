// @ts-check
import { check as env } from "./check-env.mjs";
import { check as hygiene } from "./check-hygiene.mjs";
import { check as manifest } from "./check-manifest.mjs";
import { check as paths } from "./check-paths.mjs";
import { check as rewrite } from "./check-rewrite.mjs";
import { check as scripts } from "./check-scripts.mjs";
import { check as snippets } from "./check-snippets.mjs";
import { check as symbols } from "./check-symbols.mjs";
import { check as vocab } from "./check-vocab.mjs";
import { exitCodeFor, printResult, readContext, runCheck } from "./lib/report.mjs";

const CHECKS = [paths, scripts, symbols, snippets, env, rewrite, manifest, vocab, hygiene];

const context = readContext();
if (context) {
  /** @type {{ name: string, result: import("./lib/report.mjs").CheckResult }[]} */
  const outcomes = [];
  for (const check of CHECKS) {
    const result = await runCheck(check, context);
    outcomes.push({ name: check.name, result });
    // Findings, and the reason a check reached no verdict, do not fit in the table.
    if (result.status !== "pass") printResult(check.name, result);
  }

  const nameWidth = Math.max(...outcomes.map(({ name }) => name.length));
  console.log(`\n${"check".padEnd(nameWidth)}  ${"status".padEnd(10)}  findings  scope`);
  for (const { name, result } of outcomes) {
    const status = result.status.toUpperCase().padEnd(10);
    const scope = result.summary.split("\n")[0];
    console.log(`${name.padEnd(nameWidth)}  ${status}  ${String(result.findings.length).padStart(8)}  ${scope}`);
  }
  process.exitCode = Math.max(...outcomes.map(({ result }) => exitCodeFor(result.status)));
}
