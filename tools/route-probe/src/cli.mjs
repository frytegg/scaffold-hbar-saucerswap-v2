// @ts-check
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { ProbeConfigError, loadConfig } from "./config.mjs";
import { runPositiveControls } from "./controls.mjs";
import { RouteSampleError, discoverRoutes } from "./discover-routes.mjs";
import { createThirdPartyTest, isLoopbackHostname } from "./hosts.mjs";
import { MODES } from "./modes.mjs";
import { probePage } from "./probe-page.mjs";
import { formatControls, formatFailureDetails, formatRoutes, formatThirdPartyHosts } from "./report.mjs";
import { ServerError, startProductionServer } from "./server.mjs";
import { judge } from "./verdict.mjs";

/** @typedef {import("./report.mjs").LoadResult} LoadResult */

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_PROJECT = path.resolve(TOOL_ROOT, "../../packages/nextjs");
const DEFAULT_CONFIG_FILE = path.join(TOOL_ROOT, "probe.config.json");
// The app polls its RPC endpoint every 10 s: a 12 s watch sees the first poll after first paint.
const DEFAULT_SETTLE_MS = "12000";
const DEFAULT_TIMEOUT_MS = "60000";

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_CANNOT_RUN = 2;

const USAGE = `Usage: node src/cli.mjs [options]

Loads every page route of a built Next.js project in a fresh browser context, in three modes
(${MODES.join(", ")}), and fails on a console error, an uncaught exception, a document status
of 400 or more, a body under 20 characters, or a request to a third-party host.

  --base-url <url>    where the app is served                  (default ${DEFAULT_BASE_URL})
  --project <dir>     Next.js project whose app directory lists the routes (default packages/nextjs)
  --serve             start the project's production server on the base URL's port first,
                      with no NEXT_PUBLIC_* or HEDERA_* variable, and stop it afterwards
  --config <file>     sample paths for dynamic routes          (default probe.config.json)
  --settle-ms <ms>    watch time after network idle            (default ${DEFAULT_SETTLE_MS})
  --timeout-ms <ms>   navigation and server start timeout      (default ${DEFAULT_TIMEOUT_MS})
  --help

Nothing is built here: build the project first.
Exit codes: 0 every load passed, 1 at least one failed, 2 the probe could not run.`;

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

/**
 * @param {string} flag
 * @param {string} value
 */
function parseMilliseconds(flag, value) {
  const milliseconds = Number(value);
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new CannotRunError(`--${flag} expects a whole number of milliseconds, got "${value}".`);
  }
  return milliseconds;
}

function readOptions() {
  /** @type {ReturnType<typeof parseOptions>} */
  let values;
  try {
    values = parseOptions();
  } catch (error) {
    throw new CannotRunError(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }

  const baseUrl = values["base-url"];
  if (!URL.canParse(baseUrl)) throw new CannotRunError(`--base-url expects an absolute URL, got "${baseUrl}".`);
  const { protocol, hostname } = new URL(baseUrl);
  if (values.serve && (protocol !== "http:" || !isLoopbackHostname(hostname))) {
    throw new CannotRunError(
      `--serve starts a local server: --base-url must be http on a loopback host, got "${baseUrl}".`,
    );
  }

  return {
    baseUrl,
    project: path.resolve(values.project),
    serve: values.serve,
    configFile: path.resolve(values.config),
    settleMs: parseMilliseconds("settle-ms", values["settle-ms"]),
    timeoutMs: parseMilliseconds("timeout-ms", values["timeout-ms"]),
    help: values.help,
  };
}

function parseOptions() {
  return parseArgs({
    options: {
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
      project: { type: "string", default: DEFAULT_PROJECT },
      serve: { type: "boolean", default: false },
      config: { type: "string", default: DEFAULT_CONFIG_FILE },
      "settle-ms": { type: "string", default: DEFAULT_SETTLE_MS },
      "timeout-ms": { type: "string", default: DEFAULT_TIMEOUT_MS },
      help: { type: "boolean", default: false },
    },
  }).values;
}

/**
 * @param {string} project
 * @param {Record<string, string[]>} samples
 */
async function listRoutes(project, samples) {
  const appDirectory = [path.join(project, "app"), path.join(project, "src", "app")].find(candidate =>
    existsSync(candidate),
  );
  if (appDirectory === undefined) throw new CannotRunError(`${project} has no app directory (app/ or src/app/).`);

  const routes = await discoverRoutes(appDirectory, samples);
  if (routes.paths.length === 0 && routes.unsampled.length === 0) {
    throw new CannotRunError(`No page route found under ${appDirectory}.`);
  }
  return routes;
}

/**
 * @param {string} baseUrl
 * @param {number} timeoutMs
 */
async function assertServerAnswers(baseUrl, timeoutMs) {
  try {
    await fetch(baseUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new CannotRunError(`No server answers at ${baseUrl}. Serve the built app, or pass --serve.`, {
      cause: error,
    });
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

/**
 * @param {import("playwright").Browser} browser
 * @param {string[]} routePaths
 * @param {{ baseUrl: string, settleMs: number, timeoutMs: number }} options
 * @param {(requestUrl: string) => boolean} isThirdParty
 * @returns {Promise<LoadResult[]>}
 */
async function probeRoutes(browser, routePaths, { baseUrl, settleMs, timeoutMs }, isThirdParty) {
  /** @type {LoadResult[]} */
  const results = [];
  for (const routePath of routePaths) {
    const url = new URL(routePath, baseUrl).href;
    const loads = await Promise.all(
      MODES.map(async mode => {
        const observation = await probePage(browser, { url, mode, isThirdParty, settleMs, timeoutMs });
        return { path: routePath, mode, observation, ...judge(observation) };
      }),
    );
    results.push(...loads);
  }
  return results;
}

/**
 * @param {ReturnType<typeof readOptions>} options
 * @param {{ paths: string[], unsampled: string[] }} routes
 */
async function probe(options, routes) {
  const isThirdParty = createThirdPartyTest(options.baseUrl);
  const browser = await launchBrowser();

  try {
    const controls = await runPositiveControls(browser, {
      baseUrl: options.baseUrl,
      knownPath: routes.paths[0] ?? "/",
      isThirdParty,
      timeoutMs: options.timeoutMs,
    });
    const results = await probeRoutes(browser, routes.paths, options, isThirdParty);

    console.log(`\n${formatControls(controls)}\n`);
    console.log(`${formatRoutes(results)}\n`);
    console.log(`${formatThirdPartyHosts(results)}\n`);

    const failureDetails = formatFailureDetails(results);
    if (failureDetails) console.log(`Failures:\n${failureDetails}\n`);

    if (routes.unsampled.length > 0) {
      console.log(
        `Dynamic routes with no sample path, NOT probed (declare one in ${options.configFile}):\n` +
          `${routes.unsampled.map(pattern => `  ${pattern}`).join("\n")}\n`,
      );
    }

    const blindControls = controls.filter(control => !control.detected);
    if (blindControls.length > 0) {
      console.log(`The probe is blind to: ${blindControls.map(control => control.name).join("; ")}.\n`);
    }

    const passed = blindControls.length === 0 && routes.unsampled.length === 0 && results.every(result => result.pass);
    console.log(
      `Result: ${passed ? "PASS" : "FAIL"} (${results.length} loads: ${routes.paths.length} routes x ` +
        `${MODES.length} modes, ${options.settleMs} ms watch, ${options.baseUrl})`,
    );
    return passed ? EXIT_PASS : EXIT_FAIL;
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

  const { dynamicRouteSamples } = await loadConfig(options.configFile);
  const routes = await listRoutes(options.project, dynamicRouteSamples);
  console.log(`Routes from ${options.project}: ${[...routes.paths, ...routes.unsampled].join(", ")}`);

  if (!options.serve) {
    await assertServerAnswers(options.baseUrl, options.timeoutMs);
    return probe(options, routes);
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
    exitCode = await probe(options, routes);
  } finally {
    await server.stop();
    console.log(`Server stopped, and ${new URL(options.baseUrl).host} accepts no connection any more.`);
  }
  return exitCode;
}

main().then(
  exitCode => {
    process.exitCode = exitCode;
  },
  error => {
    const expected = [CannotRunError, ProbeConfigError, RouteSampleError, ServerError].some(
      type => error instanceof type,
    );
    console.error(expected ? error.message : error);
    if (expected && error.cause instanceof Error) console.error(`Cause: ${error.cause.message}`);
    process.exitCode = EXIT_CANNOT_RUN;
  },
);
