// @ts-check
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

// Variables that configure the app. The server gets none of them, whatever the shell exports, so the
// probe sees the app the way a fresh clone without an env file runs it.
const CONFIG_VARIABLE = /^(?:NEXT_PUBLIC_|HEDERA_)/;
// What `next start` reads from the project folder, in its own order of precedence.
const PRODUCTION_ENV_FILES = [".env.production.local", ".env.local", ".env.production", ".env"];
const POLL_MS = 500;
const STOP_TIMEOUT_MS = 20_000;

export class ServerError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = "ServerError";
  }
}

/**
 * @param {NodeJS.ProcessEnv} environment
 * @returns {{ env: NodeJS.ProcessEnv, removed: string[] }}
 */
export function withoutConfiguration(environment) {
  const removed = Object.keys(environment)
    .filter(name => CONFIG_VARIABLE.test(name))
    .sort();
  const kept = Object.entries(environment).filter(([name]) => !CONFIG_VARIABLE.test(name));
  return { env: { ...Object.fromEntries(kept), NEXT_TELEMETRY_DISABLED: "1" }, removed };
}

/**
 * @param {number} port
 * @param {string} host
 * @returns {Promise<boolean>}
 */
function acceptsConnections(port, host) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Next.js listens on both stacks by default, so the port counts as taken when either loopback answers. */
async function portInUse(/** @type {number} */ port) {
  const answers = await Promise.all([acceptsConnections(port, "127.0.0.1"), acceptsConnections(port, "::1")]);
  return answers.some(Boolean);
}

/**
 * @param {() => Promise<boolean>} condition
 * @param {number} timeoutMs
 */
async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(POLL_MS);
  }
  return false;
}

/** @param {string} url */
async function answersHttp(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(POLL_MS * 4) });
    return true;
  } catch {
    // Connection refused or no answer yet: the server is still starting.
    return false;
  }
}

/** @param {import("node:child_process").ChildProcess} child */
function signalStop(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new ServerError(`taskkill exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
    }
    return;
  }
  // The server leads its own process group (detached), so the whole group gets the signal.
  process.kill(-child.pid, "SIGTERM");
}

/**
 * Starts `next start` for an already built project and resolves once it answers HTTP.
 *
 * @param {object} options
 * @param {string} options.projectDirectory the Next.js project (the folder holding .next)
 * @param {string} options.baseUrl loopback URL whose port the server binds
 * @param {number} options.timeoutMs how long the server may take to answer
 * @param {(line: string) => void} options.onOutput receives every line the server prints
 * @returns {Promise<{ removedVariables: string[], envFiles: string[], stop: () => Promise<void> }>}
 */
export async function startProductionServer({ projectDirectory, baseUrl, timeoutMs, onOutput }) {
  const port = Number(new URL(baseUrl).port || 80);
  if (!existsSync(path.join(projectDirectory, ".next", "BUILD_ID"))) {
    throw new ServerError(`${projectDirectory} has no production build: run its build script first.`);
  }
  if (await portInUse(port)) {
    throw new ServerError(`Port ${port} is already in use: stop what listens there or choose another --base-url.`);
  }

  /** @type {string} */
  let nextBin;
  try {
    nextBin = createRequire(path.join(projectDirectory, "package.json")).resolve("next/dist/bin/next");
  } catch (error) {
    throw new ServerError(`Next.js is not installed for ${projectDirectory}: install the dependencies first.`, {
      cause: error,
    });
  }

  const { env, removed } = withoutConfiguration(process.env);
  const child = spawn(process.execPath, [nextBin, "start", "--port", String(port)], {
    cwd: projectDirectory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  /** @type {Error | null} */
  let spawnError = null;
  child.once("error", error => {
    spawnError = error;
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on("line", onOutput);
  }

  const hasEnded = () => spawnError !== null || child.exitCode !== null || child.signalCode !== null;

  const stop = async () => {
    if (!hasEnded()) signalStop(child);
    const deadline = sleep(STOP_TIMEOUT_MS, false, { ref: false });
    const stopped = await Promise.race([exited.then(() => true), deadline]);
    if (!stopped) throw new ServerError(`The server (pid ${child.pid}) did not stop within ${STOP_TIMEOUT_MS} ms.`);
    if (!(await waitFor(async () => !(await portInUse(port)), STOP_TIMEOUT_MS))) {
      throw new ServerError(`Port ${port} still accepts connections after the server stopped.`);
    }
  };

  const ready = await waitFor(async () => hasEnded() || (await answersHttp(baseUrl)), timeoutMs);
  if (spawnError !== null) throw new ServerError("The server could not be started.", { cause: spawnError });
  if (hasEnded()) {
    throw new ServerError(`The server exited with ${child.signalCode ?? `code ${child.exitCode}`} before answering.`);
  }
  if (!ready) {
    await stop();
    throw new ServerError(`The server did not answer within ${timeoutMs} ms; it was stopped.`);
  }

  const envFiles = PRODUCTION_ENV_FILES.filter(name => existsSync(path.join(projectDirectory, name)));
  return { removedVariables: removed, envFiles, stop };
}
