// Boots the production server of a built project with no configuration, requests every route of the build once
// (rules in routes.mjs), then stops the server and confirms that the port is free again.
//
// usage: node boot-check.mjs --port <n> --next-dir <dir> --server-log <file> [--route <path>]... -- <serve command...>
// exit:  0 when every rule holds, 1 otherwise
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { collectTargets, judgeAnswer } from "./routes.mjs";

const HOST = "127.0.0.1";
const BOOT_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 20_000;
const POLL_MS = 1_000;
const CONFIG_VARIABLE = /^(NEXT_PUBLIC_|HEDERA_)/;

/** @typedef {import("./routes.mjs").Target} Target */
/** @typedef {{ child: import("node:child_process").ChildProcess, exit: string | null }} Server */

function readOptions() {
  const { values, positionals } = parseArgs({
    options: {
      port: { type: "string" },
      "next-dir": { type: "string" },
      "server-log": { type: "string" },
      route: { type: "string", multiple: true, default: [] },
    },
    allowPositionals: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port must be a TCP port, got "${values.port}"`);
  }
  if (!values["next-dir"]) throw new Error("--next-dir is required");
  if (!values["server-log"]) throw new Error("--server-log is required");
  if (positionals.length === 0) throw new Error("the serve command is required after --");
  const badRoute = values.route.find(route => !route.startsWith("/"));
  if (badRoute !== undefined) {
    throw new Error(
      `--route must start with "/", got "${badRoute}" (Git Bash rewrites such arguments unless MSYS_NO_PATHCONV=1)`,
    );
  }
  return {
    port,
    nextDir: values["next-dir"],
    serverLog: values["server-log"],
    extraRoutes: values.route,
    command: positionals,
  };
}

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function portIsOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, HOST);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * @param {() => Promise<boolean>} condition
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} whether the condition held before the timeout
 */
async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(POLL_MS);
  }
  return false;
}

/**
 * @param {string[]} command
 * @param {number} port
 * @param {string} serverLog
 * @returns {Server}
 */
function startServer(command, port, serverLog) {
  const removed = Object.keys(process.env).filter(name => CONFIG_VARIABLE.test(name));
  console.log(
    `configuration variables removed from the server environment (names only): ${removed.join(" ") || "none"}`,
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !CONFIG_VARIABLE.test(name)));
  env.PORT = String(port);
  env.NEXT_TELEMETRY_DISABLED = "1";

  const log = openSync(serverLog, "a");
  /** @type {import("node:child_process").StdioOptions} */
  const stdio = ["ignore", log, log];
  // Windows needs a shell to resolve the package manager's .cmd shim; the words come from the calling script
  // (fixed words and its own paths), never from user input. Elsewhere the server leads its own process group so
  // that the whole tree can be signalled at once.
  const child =
    process.platform === "win32"
      ? spawn(command.map(word => (/\s/.test(word) ? `"${word}"` : word)).join(" "), { shell: true, env, stdio })
      : spawn(command[0], command.slice(1), { detached: true, env, stdio });
  closeSync(log);

  /** @type {Server} */
  const server = { child, exit: null };
  child.once("exit", (code, signal) => {
    server.exit = `exit code ${code}, signal ${signal}`;
  });
  child.once("error", error => {
    server.exit = `could not start: ${error.message}`;
  });
  return server;
}

/**
 * @param {Server} server
 * @param {NodeJS.Signals} signal
 */
function signalTree(server, signal) {
  const { pid } = server.child;
  // No pid: the process never started, and its "error" event has already said why.
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // taskkill walks the tree from the shell's pid, which no longer exists once the shell has exited.
    if (server.exit !== null) return;
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
    if (result.status !== 0) console.log(`taskkill exit ${result.status}: ${(result.stderr || result.stdout).trim()}`);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

/**
 * @param {Server} server
 * @param {number} port
 * @returns {Promise<string | null>} a problem when the port stays open, null once it is closed
 */
async function stopServer(server, port) {
  const portIsClosed = async () => !(await portIsOpen(port));
  signalTree(server, "SIGTERM");
  if (await waitFor(portIsClosed, SHUTDOWN_TIMEOUT_MS)) return null;
  signalTree(server, "SIGKILL");
  if (await waitFor(portIsClosed, SHUTDOWN_TIMEOUT_MS)) return null;
  return `port ${port} is still open after the server was stopped`;
}

/**
 * @param {Target} target
 * @param {number} port
 * @returns {Promise<string | null>} what is wrong with the answer, or null
 */
async function request(target, port) {
  let response;
  let body;
  try {
    response = await fetch(`http://${HOST}:${port}${target.route}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    body = await response.text();
  } catch (error) {
    return `${target.route}: request failed (${error instanceof Error ? error.message : String(error)})`;
  }
  console.log(`route=${target.route} kind=${target.kind} status=${response.status} bytes=${Buffer.byteLength(body)}`);
  return judgeAnswer(target, response.status, response.headers.get("content-type") ?? "", body);
}

async function main() {
  const options = readOptions();
  const { targets, problems } = collectTargets(options.nextDir, options.extraRoutes);
  if (await portIsOpen(options.port)) {
    throw new Error(`port ${options.port} is already in use: refusing to probe a server this run did not start`);
  }

  console.log(`starting: PORT=${options.port} ${options.command.join(" ")}`);
  const server = startServer(options.command, options.port, options.serverLog);
  try {
    const settled = await waitFor(
      async () => server.exit !== null || (await portIsOpen(options.port)),
      BOOT_TIMEOUT_MS,
    );
    if (server.exit !== null) {
      problems.push(
        `the server stopped before it listened on ${options.port} (${server.exit}); see ${options.serverLog}`,
      );
    } else if (!settled) {
      problems.push(
        `the server did not listen on ${options.port} within ${BOOT_TIMEOUT_MS / 1000} s; see ${options.serverLog}`,
      );
    } else {
      for (const target of targets) {
        const problem = await request(target, options.port);
        if (problem !== null) problems.push(problem);
      }
    }
  } finally {
    const leftover = await stopServer(server, options.port);
    if (leftover !== null) problems.push(leftover);
  }

  console.log(
    `routes to request: ${targets.length}; port ${options.port} open after stop: ${await portIsOpen(options.port)}`,
  );
  for (const problem of problems) console.log(`FAILED ${problem}`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
