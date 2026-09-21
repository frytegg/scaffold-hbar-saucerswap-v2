// Which routes a production build serves, and the rule each answer has to meet. Pure functions, no network.
//
//   page            status below 400, and an HTML body with at least 20 characters of visible text
//   dynamic page    one target per prerendered instance; every extra route that matches its pattern counts too
//   route handler   a bare GET must not answer 5xx (a 4xx for a missing parameter is a correct answer)
//   extra route     status below 400; meant for handlers that need a query string
import { readFileSync } from "node:fs";
import path from "node:path";

const MIN_VISIBLE_TEXT = 20;
const NOT_FOUND_ROUTE = "/_not-found";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${file}: is the production build missing?`, { cause: error });
  }
}

function patternOf(route) {
  const source = route
    .split("/")
    .filter(Boolean)
    .map(segment => {
      if (/^\[\[\.\.\..+\]\]$/.test(segment)) return "(?:/.+)?";
      if (/^\[\.\.\..+\]$/.test(segment)) return "/.+";
      if (/^\[.+\]$/.test(segment)) return "/[^/]+";
      return `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    })
    .join("");
  return new RegExp(`^${source || "/"}$`);
}

function pathnameOf(route) {
  return route.split(/[?#]/)[0];
}

/**
 * @param {string} nextDir the build output directory (it holds app-path-routes-manifest.json)
 * @param {string[]} extraRoutes concrete paths given by the caller, query string included
 * @returns {{ targets: { route: string, kind: "page" | "handler" | "extra", maxStatus: number }[], problems: string[] }}
 */
export function collectTargets(nextDir, extraRoutes) {
  const appRoutes = readJson(path.join(nextDir, "app-path-routes-manifest.json"));
  const prerendered = readJson(path.join(nextDir, "prerender-manifest.json")).routes ?? {};
  const targets = [];
  const problems = [];

  for (const [entry, route] of Object.entries(appRoutes)) {
    if (route === NOT_FOUND_ROUTE) continue;
    const isHandler = entry.endsWith("/route");
    const pattern = patternOf(route);
    const covered = extraRoutes.some(extra => pattern.test(pathnameOf(extra)));
    if (!route.includes("[")) {
      if (isHandler && covered) continue;
      targets.push({ route, kind: isHandler ? "handler" : "page", maxStatus: isHandler ? 499 : 399 });
      continue;
    }
    const instances = Object.entries(prerendered)
      .filter(([, details]) => details.srcRoute === route)
      .map(([instance]) => instance);
    if (instances.length === 0 && !covered) {
      problems.push(`${route}: no prerendered instance and no extra route matches it, so it cannot be requested`);
    }
    for (const instance of instances) targets.push({ route: instance, kind: "page", maxStatus: 399 });
  }
  for (const route of extraRoutes) targets.push({ route, kind: "extra", maxStatus: 399 });
  return { targets, problems };
}

export function visibleTextLength(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/** @returns {string | null} what is wrong with the answer, or null when it meets the target's rule */
export function judgeAnswer(target, status, contentType, body) {
  if (status > target.maxStatus) return `${target.route}: status ${status}, expected at most ${target.maxStatus}`;
  const isRenderedPage = contentType.includes("text/html") && status < 300;
  if (isRenderedPage && visibleTextLength(body) < MIN_VISIBLE_TEXT) {
    return `${target.route}: ${visibleTextLength(body)} characters of visible text, expected at least ${MIN_VISIBLE_TEXT}`;
  }
  return null;
}
