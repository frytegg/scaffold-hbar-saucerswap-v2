// @ts-check
import { withTsLoader } from "./loadTs.mjs";

// The command that tries to break this template's own claim. The replay command says every sentence it prints is
// computed from a captured answer; this alters three of those answers and shows the sentences follow. It writes
// nothing, reaches no network, and exits 1 if a sentence survives its evidence being falsified.

const REPORT = "./lib/hedera/__live__/tamperCaptured.ts";

const { report, exitCode } = await withTsLoader(async load => {
  const { exitCodeOf, renderTamper, tamperCaptured } = await load(REPORT);
  const run = await tamperCaptured();
  return { report: renderTamper(run), exitCode: exitCodeOf(run) };
});

process.stdout.write(`${report}\n`);
process.exitCode = exitCode;
