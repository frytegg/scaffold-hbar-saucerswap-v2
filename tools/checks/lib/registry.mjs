// @ts-check
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { UnverifiableError } from "./report.mjs";

const REGISTRY = "https://registry.npmjs.org";
/** Abbreviated metadata: every version with its `dist`, without the readmes. */
const ABBREVIATED = "application/vnd.npm.install-v1+json";
const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_DELAYS_MS = [0, 1_000, 2_000];
const RELEASE = /^\d+\.\d+\.\d+$/;

/** Downloads made by earlier runs. Online runs check them against the registry's digest before use. */
export const CACHE_DIR = path.join(os.tmpdir(), "scaffold-hbar-checks");

/** @typedef {{ name: string, version: string, dist: { tarball: string, integrity: string } }} PublishedVersion */

/**
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, headers = {}) {
  let lastFailure = "no attempt made";
  for (const [attempt, delay] of RETRY_DELAYS_MS.entries()) {
    await sleep(delay);
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) return response;
      lastFailure = `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastFailure = error instanceof Error ? `${error.message} (${String(error.cause ?? "no cause")})` : String(error);
    }
    console.error(`${url}: attempt ${attempt + 1} of ${RETRY_DELAYS_MS.length} failed: ${lastFailure}`);
  }
  throw new UnverifiableError(`${url} could not be fetched: ${lastFailure}`);
}

/**
 * @param {string} name
 * @param {string} tag a dist-tag or an exact version
 * @returns {Promise<PublishedVersion>}
 */
export async function fetchVersion(name, tag) {
  return /** @type {PublishedVersion} */ (await (await fetchWithRetry(`${REGISTRY}/${name}/${tag}`)).json());
}

/**
 * @param {string} name
 * @returns {Promise<Map<string, PublishedVersion>>} every published version, by version string
 */
export async function fetchVersions(name) {
  const document = /** @type {{ versions: Record<string, PublishedVersion> }} */ (
    await (await fetchWithRetry(`${REGISTRY}/${name}`, { accept: ABBREVIATED })).json()
  );
  return new Map(Object.entries(document.versions));
}

/**
 * @param {Buffer} tarball
 * @param {string} integrity as the registry states it: `<algorithm>-<base64 digest>`
 * @returns {boolean}
 */
function matchesIntegrity(tarball, integrity) {
  const [algorithm, expected] = integrity.split("-", 2);
  return createHash(algorithm).update(tarball).digest("base64") === expected;
}

/**
 * @param {string} name
 * @param {string} version
 * @returns {string}
 */
function cachedTarballPath(name, version) {
  return path.join(CACHE_DIR, `${name}-${version}.tgz`);
}

/**
 * The tarball of one published version, from the cache when the copy there still matches the registry's digest.
 * @param {PublishedVersion} published
 * @returns {Promise<Buffer>}
 */
export async function fetchTarball({ name, version, dist }) {
  const cached = cachedTarballPath(name, version);
  if (existsSync(cached)) {
    const tarball = readFileSync(cached);
    if (matchesIntegrity(tarball, dist.integrity)) return tarball;
    console.error(`${cached} does not match the registry's digest: downloading it again`);
  }
  const tarball = Buffer.from(await (await fetchWithRetry(dist.tarball)).arrayBuffer());
  if (!matchesIntegrity(tarball, dist.integrity)) {
    throw new UnverifiableError(`${name}@${version}: the downloaded tarball does not match the registry's digest`);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const partial = `${cached}.${process.pid}.partial`;
  writeFileSync(partial, tarball);
  renameSync(partial, cached);
  return tarball;
}

/**
 * @param {string} name
 * @returns {string[]} versions that earlier online runs left in the cache
 */
export function cachedVersions(name) {
  if (!existsSync(CACHE_DIR)) return [];
  const prefix = `${name}-`;
  return readdirSync(CACHE_DIR)
    .filter(file => file.startsWith(prefix) && file.endsWith(".tgz"))
    .map(file => file.slice(prefix.length, -".tgz".length))
    .filter(version => RELEASE.test(version));
}

/**
 * @param {string} name
 * @param {string} version
 * @returns {Buffer}
 */
export function readCachedTarball(name, version) {
  return readFileSync(cachedTarballPath(name, version));
}

/**
 * @param {string} version
 * @returns {number[]}
 */
function partsOf(version) {
  return version.split(".").map(Number);
}

/**
 * @param {number[]} left
 * @param {number[]} right
 * @returns {number}
 */
function compareVersions(left, right) {
  const index = left.findIndex((part, position) => part !== right[position]);
  return index === -1 ? 0 : left[index] - right[index];
}

/**
 * @param {string[]} versions
 * @returns {string | undefined} the highest release; pre-releases are never chosen
 */
export function highestVersion(versions) {
  return versions
    .filter(version => RELEASE.test(version))
    .map(partsOf)
    .sort(compareVersions)
    .at(-1)
    ?.join(".");
}

/**
 * The version a package manager installs for a dependency range, limited to the two forms published packages
 * use for their own dependencies: an exact version and a caret range.
 * @param {string[]} versions
 * @param {string} range
 * @returns {string | undefined}
 */
export function maxSatisfying(versions, range) {
  const form = /^(\^?)(\d+\.\d+\.\d+)$/.exec(range.trim());
  if (!form) throw new UnverifiableError(`dependency range "${range}" is neither an exact version nor a caret range`);
  const floor = partsOf(form[2]);
  // A caret fixes every part up to the first non-zero one: ^3.24.1 accepts 3.x.y from 3.24.1 on, ^0.4.0 only 0.4.x.
  const fixed = form[1] === "" ? 3 : floor[0] !== 0 ? 1 : floor[1] !== 0 ? 2 : 3;
  return highestVersion(
    versions.filter(version => {
      if (!RELEASE.test(version)) return false;
      const candidate = partsOf(version);
      return (
        candidate.slice(0, fixed).every((part, index) => part === floor[index]) &&
        compareVersions(candidate, floor) >= 0
      );
    }),
  );
}
