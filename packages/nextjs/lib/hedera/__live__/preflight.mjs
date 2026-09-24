// @ts-check
import { withTsLoader } from "./loadTs.mjs";
import { createInterface } from "node:readline";

// The command that answers about an account you choose: it asks for one on standard input, reads it on Hedera's
// public mirror node, and prints what this template's pre-flight checks say for it — the same verdicts, sentences
// and actions a page shows. Keyless: nothing is signed and no private key is read.
//
// It asks rather than taking the account as an argument. A project scaffolded for the other package manager runs
// each documented command through that manager, which forwards what follows the script name only after a few names
// this one is not among, so an account passed on the command line would be silently dropped there and kept here.
// A question behaves the same under both.
//
// It reads two third-party endpoints, so it belongs beside the check:live script and never inside check:all: when
// one of them does not answer, the report says so and the command exits non-zero instead of printing a verdict.
// Which non-zero is part of what it answers, and that is why the root script runs this file itself instead of
// delegating to the workspace script beside it as the other commands do: a root script that calls a second package-
// manager command reports 1 for every failure, and the difference between "you gave me no account" and "a third
// party is down" would be lost on the way out.

const REPORT = "./lib/hedera/__live__/preflightReport.ts";
const CLIENTS = "./lib/hedera/__live__/testnet.ts";
const UPSTREAMS = "./services/hedera/upstreams.ts";

const QUESTION = "An EVM address (0x…) or a Hedera account id (0.0.…): ";

/**
 * One line from standard input, or null when it ended without one. The prompt is written here rather than by
 * readline so that it appears whether or not a terminal is attached, which is what makes a piped answer behave like
 * a typed one.
 * @returns {Promise<string | null>}
 */
async function askForAccount() {
  process.stdout.write(QUESTION);
  const lines = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of lines) return line;
    return null;
  } finally {
    lines.close();
  }
}

const { report, exitCode } = await withTsLoader(async load => {
  const { exitCodeOf, renderIgnoredArguments, renderPreflight, runPreflight } = await load(REPORT);
  const { mirrorBaseUrl, testnetClient, testnetMirror } = await load(CLIENTS);
  const { jsonRpcUrl } = await load(UPSTREAMS);

  // An account after the command name arrives here under one package manager and not the other, and is read under
  // neither: say so before asking, rather than answering a question nobody asked.
  const ignored = renderIgnoredArguments(process.argv.slice(2));
  if (ignored !== "") process.stdout.write(`${ignored}\n\n`);

  const typed = await askForAccount();
  process.stdout.write("\n");

  const outcome = await runPreflight({
    mirror: testnetMirror,
    client: testnetClient,
    typed: typed ?? "",
    mirrorBaseUrl,
    relayUrl: jsonRpcUrl("testnet"),
  });
  return { report: renderPreflight(outcome), exitCode: exitCodeOf(outcome) };
});

process.stdout.write(report);
process.exitCode = exitCode;
