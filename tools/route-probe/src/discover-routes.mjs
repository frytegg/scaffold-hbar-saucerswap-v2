// @ts-check
import { readdir } from "node:fs/promises";
import path from "node:path";

const PAGE_FILE = /^page\.(?:tsx|ts|jsx|js)$/;
const ROUTE_GROUP = /^\(.+\)$/;
const INTERCEPTING_ROUTE = /^\(\.{1,3}\)/;
const DYNAMIC_SEGMENT = /^\[.+\]$/;
const CATCH_ALL_SEGMENT = /^\[\.{3}.+\]$/;
const OPTIONAL_CATCH_ALL_SEGMENT = /^\[\[\.{3}.+\]\]$/;

export class RouteSampleError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "RouteSampleError";
  }
}

/**
 * Private folders, parallel-route slots and intercepting routes render inside another route:
 * none of them adds a URL of its own.
 * @param {string} folderName
 */
function addsNoUrl(folderName) {
  return folderName.startsWith("_") || folderName.startsWith("@") || INTERCEPTING_ROUTE.test(folderName);
}

/**
 * @param {string} directory
 * @param {readonly string[]} segments
 * @returns {Promise<string[]>}
 */
async function collectPagePatterns(directory, segments) {
  const entries = await readdir(directory, { withFileTypes: true });
  const patterns = [];

  if (entries.some(entry => entry.isFile() && PAGE_FILE.test(entry.name))) {
    patterns.push(`/${segments.join("/")}`);
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || addsNoUrl(entry.name)) continue;
    const childSegments = ROUTE_GROUP.test(entry.name) ? segments : [...segments, entry.name];
    patterns.push(...(await collectPagePatterns(path.join(directory, entry.name), childSegments)));
  }

  return patterns;
}

/** @param {string} routePath */
function splitSegments(routePath) {
  return routePath.split("/").filter(segment => segment.length > 0);
}

/** @param {string} pattern */
export function isDynamicPattern(pattern) {
  return splitSegments(pattern).some(segment => DYNAMIC_SEGMENT.test(segment));
}

/**
 * @param {string} pattern a route as the app directory spells it, for example "/token/[id]"
 * @param {string} routePath a concrete path, for example "/token/42"
 */
export function matchesPattern(pattern, routePath) {
  if (!routePath.startsWith("/")) return false;

  const patternSegments = splitSegments(pattern);
  const pathSegments = splitSegments(routePath);

  for (const [index, patternSegment] of patternSegments.entries()) {
    if (OPTIONAL_CATCH_ALL_SEGMENT.test(patternSegment)) return true;
    if (CATCH_ALL_SEGMENT.test(patternSegment)) return pathSegments.length > index;

    const pathSegment = pathSegments[index];
    if (pathSegment === undefined) return false;
    if (!DYNAMIC_SEGMENT.test(patternSegment) && patternSegment !== pathSegment) return false;
  }

  return pathSegments.length === patternSegments.length;
}

/**
 * Lists the page routes of a Next.js app directory. A dynamic route has no URL until somebody names
 * one, so it is probed through the sample paths declared for it and reported as unsampled otherwise.
 *
 * @param {string} appDirectory
 * @param {Readonly<Record<string, readonly string[]>>} [samples] concrete paths keyed by dynamic pattern
 * @returns {Promise<{ paths: string[], unsampled: string[] }>}
 */
export async function discoverRoutes(appDirectory, samples = {}) {
  const patterns = [...new Set(await collectPagePatterns(appDirectory, []))].sort();
  const dynamicPatterns = patterns.filter(isDynamicPattern);

  for (const [pattern, samplePaths] of Object.entries(samples)) {
    if (!dynamicPatterns.includes(pattern)) {
      throw new RouteSampleError(`Samples are declared for "${pattern}", which is not a dynamic route of the app.`);
    }
    const mismatch = samplePaths.find(samplePath => !matchesPattern(pattern, samplePath));
    if (mismatch !== undefined) {
      throw new RouteSampleError(`Sample "${mismatch}" does not match the route "${pattern}".`);
    }
  }

  return {
    paths: patterns.flatMap(pattern => (isDynamicPattern(pattern) ? (samples[pattern] ?? []) : [pattern])),
    unsampled: dynamicPatterns.filter(pattern => (samples[pattern] ?? []).length === 0),
  };
}
