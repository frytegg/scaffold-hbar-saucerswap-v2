// @ts-check
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { createThirdPartyTest, isLoopbackHostname } from "./hosts.mjs";
import { ServerError, startProductionServer } from "./server.mjs";

/** @typedef {import("playwright").Browser} Browser */
/** @typedef {import("playwright").Locator} Locator */

// The pictures of the product in `docs/` are taken by this, never by hand: a state that stops being reachable, or
// stops answering what its caption says it answers, fails the run instead of leaving a stale picture behind.

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = path.resolve(TOOL_ROOT, "../..");
const DEFAULT_PROJECT = path.resolve(REPOSITORY_ROOT, "packages/nextjs");
const DEFAULT_OUT = path.resolve(REPOSITORY_ROOT, "docs/images");
// Not the port `probe:routes` and `dev` use, so a shot can be taken while one of them is running.
const DEFAULT_BASE_URL = "http://localhost:3210";
const DEFAULT_TIMEOUT_MS = "60000";

// Every tracked image ships into every scaffold, so each one is kept small enough to be worth that.
const SIZE_LIMIT_BYTES = 150 * 1024;
// Wide enough for the app's own max-w-4xl container, so no panel is captured at a width nobody reads it at.
const VIEWPORT = { width: 960, height: 1200 };
// A picture read at 1x on a high-density screen: the text stays legible after the panel is cropped out.
const DEVICE_SCALE_FACTOR = 2;

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_CANNOT_RUN = 2;

/**
 * @typedef {object} Shot
 * @property {string} file written under the output directory
 * @property {string} route the page it is taken on
 * @property {string} panel text that names the one section the picture is cropped to
 * @property {string} shows what the picture is evidence of, printed in the report
 * @property {string} [click] accessible name of the button pressed first
 * @property {string} [settles] text the panel must hold before the picture is taken
 * @property {string[]} expect every string the panel holds once it has settled
 */

/**
 * What is captured, and what each picture has to be showing for the run to pass. Nothing here connects a wallet:
 * these are the states a reader reaches with no wallet, no key and no account, which is what a judge sees.
 *
 * @type {Shot[]}
 */
export const SHOTS = [
  {
    file: "swap-preflight-refusal.png",
    route: "/swap",
    panel: "The same checks, with no wallet",
    shows: "the keyless pre-flight refusing a token-input swap, with the reason and the action to take",
    click: "Run the pre-flight",
    settles: "What to do:",
    expect: [
      "blocked",
      "The router may spend your token",
      "The SaucerSwap router has no allowance to spend your SAUCE.",
      "without it the network rejects the swap and still charges the gas",
      "What to do: Approve 1 SAUCE for the router",
    ],
  },
];

class CannotRunError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = "CannotRunError";
  }
}

const USAGE = `Usage: node src/shots.mjs [options]

Drives a built Next.js app in Chromium and writes one PNG per declared shot, cropped to the panel that
argues. A shot whose panel is missing, whose state has changed, or whose file would be over
${SIZE_LIMIT_BYTES / 1024} KB fails the run, and so does a console error or a request to a third-party host.

  --base-url <url>    where the app is served                  (default ${DEFAULT_BASE_URL})
  --project <dir>     the Next.js project to serve             (default packages/nextjs)
  --out <dir>         where the PNGs are written               (default docs/images)
  --serve             start the project's production server on the base URL's port first,
                      with no NEXT_PUBLIC_* or HEDERA_* variable, and stop it afterwards
  --timeout-ms <ms>   navigation, action and server start timeout (default ${DEFAULT_TIMEOUT_MS})
  --help

Nothing is built here: build the project first. Every read the pages make is keyless and leaves from the
app's own origin; nothing is signed and no wallet is connected.
Exit codes: 0 every shot was taken, 1 a shot failed, 2 the tool could not run.`;

function readOptions() {
  /** @type {{ [name: string]: string | boolean | undefined }} */
  let values;
  try {
    values = parseArgs({
      options: {
        "base-url": { type: "string", default: DEFAULT_BASE_URL },
        project: { type: "string", default: DEFAULT_PROJECT },
        out: { type: "string", default: DEFAULT_OUT },
        serve: { type: "boolean", default: false },
        "timeout-ms": { type: "string", default: DEFAULT_TIMEOUT_MS },
        help: { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    throw new CannotRunError(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }

  const baseUrl = String(values["base-url"]);
  if (!URL.canParse(baseUrl)) throw new CannotRunError(`--base-url expects an absolute URL, got "${baseUrl}".`);
  const { protocol, hostname } = new URL(baseUrl);
  if (values.serve === true && (protocol !== "http:" || !isLoopbackHostname(hostname))) {
    throw new CannotRunError(
      `--serve starts a local server: --base-url must be http on a loopback host, got "${baseUrl}".`,
    );
  }
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CannotRunError(`--timeout-ms expects a whole number of milliseconds, got "${values["timeout-ms"]}".`);
  }

  return {
    baseUrl,
    project: path.resolve(String(values.project)),
    out: path.resolve(String(values.out)),
    serve: values.serve === true,
    timeoutMs,
    help: values.help === true,
  };
}

/** How a browser renders a paragraph is not how a doc writes it: one space is one space on both sides. */
function flattened(/** @type {string} */ text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * What a panel does not say. This is the whole guard against a stale picture: a state that stops answering what
 * its caption claims fails the run here, before the file is written again.
 *
 * @param {string} panelText as the browser renders it
 * @param {readonly string[]} expected
 * @returns {string[]} empty when the panel says everything
 */
export function missingExpectations(panelText, expected) {
  const text = flattened(panelText);
  return expected.filter(one => !text.includes(flattened(one)));
}

/**
 * @param {number} bytes
 * @returns {string | null} why the file is too big to ship, or null
 */
export function oversizeFailure(bytes) {
  if (bytes <= SIZE_LIMIT_BYTES) return null;
  return `${(bytes / 1024).toFixed(0)} KB: over the ${SIZE_LIMIT_BYTES / 1024} KB limit for a shipped image`;
}

/**
 * @param {number} found sections of the route holding the panel's text
 * @param {Shot} shot
 * @returns {string | null} why the picture cannot be cropped, or null
 */
export function panelCountFailure(found, shot) {
  if (found === 1) return null;
  return `${shot.route} has ${found} sections holding "${shot.panel}", expected exactly 1.`;
}

/**
 * The one section of the page that holds the shot's text. Exactly one, so a picture is never cropped to
 * whichever panel happened to match first.
 *
 * @param {import("playwright").Page} page
 * @param {Shot} shot
 * @returns {Promise<Locator>}
 */
async function panelOf(page, shot) {
  const panel = page.locator("section").filter({ hasText: shot.panel });
  const wrongCount = panelCountFailure(await panel.count(), shot);
  if (wrongCount !== null) throw new CannotRunError(wrongCount);
  return panel.first();
}

/**
 * @param {Locator} panel
 * @param {Shot} shot
 * @param {number} timeoutMs
 * @returns {Promise<string[]>} what the panel does not say, empty when it says everything
 */
async function missingFrom(panel, shot, timeoutMs) {
  if (shot.settles !== undefined) {
    await panel.getByText(shot.settles, { exact: false }).first().waitFor({ state: "visible", timeout: timeoutMs });
  }
  return missingExpectations(await panel.innerText(), shot.expect);
}

/**
 * @param {Browser} browser
 * @param {Shot} shot
 * @param {{ baseUrl: string, out: string, timeoutMs: number, isThirdParty: (url: string) => boolean }} options
 * @returns {Promise<{ file: string, bytes: number, failures: string[] }>}
 */
async function takeShot(browser, shot, { baseUrl, out, timeoutMs, isThirdParty }) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-GB",
    timezoneId: "UTC",
  });

  try {
    /** @type {string[]} */
    const failures = [];
    context.on("request", request => {
      if (isThirdParty(request.url())) failures.push(`request to a third-party host: ${request.url()}`);
    });

    const page = await context.newPage();
    page.on("console", message => {
      if (message.type() === "error") failures.push(`console error: ${message.text()}`);
    });
    page.on("pageerror", error => failures.push(`uncaught exception: ${error.message}`));

    await page.goto(new URL(shot.route, baseUrl).href, { waitUntil: "networkidle", timeout: timeoutMs });
    const panel = await panelOf(page, shot);
    if (shot.click !== undefined) {
      await panel.getByRole("button", { name: shot.click }).click({ timeout: timeoutMs });
    }
    const missing = await missingFrom(panel, shot, timeoutMs);
    for (const expected of missing) failures.push(`the panel no longer says "${expected}"`);

    // Web fonts decide the width of every line: a picture taken before they arrive is not the page.
    await page.evaluate(() => document.fonts.ready);
    const file = path.join(out, shot.file);
    await panel.screenshot({ path: file, animations: "disabled", scale: "device" });

    const { size } = await stat(file);
    const oversize = oversizeFailure(size);
    if (oversize !== null) failures.push(oversize);
    return { file: shot.file, bytes: size, failures };
  } finally {
    await context.close();
  }
}

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (error) {
    throw new CannotRunError('Chromium did not start. Install it with the "browsers" script of tools/route-probe.', {
      cause: error,
    });
  }
}

/** @param {ReturnType<typeof readOptions>} options */
async function capture(options) {
  const isThirdParty = createThirdPartyTest(options.baseUrl);
  await mkdir(options.out, { recursive: true });
  const browser = await launchBrowser();

  try {
    /** @type {{ shot: Shot, result: Awaited<ReturnType<typeof takeShot>> }[]} */
    const taken = [];
    for (const shot of SHOTS) {
      taken.push({ shot, result: await takeShot(browser, shot, { ...options, isThirdParty }) });
    }

    const width = Math.max(...taken.map(({ result }) => result.file.length));
    console.log(`\n${"file".padEnd(width)}  ${"size".padStart(7)}  route       shows`);
    for (const { shot, result } of taken) {
      const size = `${(result.bytes / 1024).toFixed(0)} KB`.padStart(7);
      console.log(`${result.file.padEnd(width)}  ${size}  ${shot.route.padEnd(10)}  ${shot.shows}`);
    }

    const failed = taken.filter(({ result }) => result.failures.length > 0);
    if (failed.length > 0) {
      console.log(
        `\nFailures:\n${failed
          .map(({ result }) => result.failures.map(failure => `  ${result.file}: ${failure}`).join("\n"))
          .join("\n")}`,
      );
    }
    console.log(`\nWritten to ${options.out}`);
    console.log(`Result: ${failed.length === 0 ? "PASS" : "FAIL"} (${taken.length} shots, ${options.baseUrl})`);
    return failed.length === 0 ? EXIT_PASS : EXIT_FAIL;
  } finally {
    await browser.close();
  }
}

async function main() {
  const options = readOptions();
  if (options.help) {
    console.log(USAGE);
    return EXIT_PASS;
  }
  console.log(`Shots: ${SHOTS.map(shot => shot.file).join(", ")}`);

  if (!options.serve) {
    return capture(options);
  }

  const server = await startProductionServer({
    projectDirectory: options.project,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
    onOutput: line => console.log(`[server] ${line}`),
  });
  console.log(`Removed from the server environment: ${server.removedVariables.join(", ") || "nothing"}`);
  console.log(`Env files the server loads: ${server.envFiles.join(", ") || "none"}`);

  /** @type {number} */
  let exitCode;
  try {
    exitCode = await capture(options);
  } finally {
    await server.stop();
    console.log(`Server stopped, and ${new URL(options.baseUrl).host} accepts no connection any more.`);
  }
  return exitCode;
}

const entryPoint = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (entryPoint === fileURLToPath(import.meta.url)) {
  main().then(
    exitCode => {
      process.exitCode = exitCode;
    },
    error => {
      const expected = [CannotRunError, ServerError].some(type => error instanceof type);
      console.error(expected ? error.message : error);
      if (expected && error.cause instanceof Error) console.error(`Cause: ${error.cause.message}`);
      process.exitCode = EXIT_CANNOT_RUN;
    },
  );
}
