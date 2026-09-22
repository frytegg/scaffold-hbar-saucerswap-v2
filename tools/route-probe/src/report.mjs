// @ts-check

/** @typedef {import("./controls.mjs").ControlResult} ControlResult */
/** @typedef {import("./modes.mjs").Mode} Mode */
/** @typedef {import("./verdict.mjs").Observation} Observation */
/** @typedef {import("./verdict.mjs").FailureReason} FailureReason */

/**
 * @typedef {object} LoadResult
 * @property {string} path
 * @property {Mode} mode
 * @property {Observation} observation
 * @property {boolean} pass
 * @property {FailureReason[]} reasons
 */

/**
 * @param {readonly string[]} headers
 * @param {readonly (readonly string[])[]} rows
 */
export function formatTable(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map(row => (row[column] ?? "").length)),
  );
  /** @param {readonly string[]} cells */
  const formatRow = cells =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();

  return [formatRow(headers), formatRow(widths.map(width => "-".repeat(width))), ...rows.map(formatRow)].join("\n");
}

/** @param {readonly ControlResult[]} controls */
export function formatControls(controls) {
  return formatTable(
    ["positive control", "mode", "must fail with", "failed with", "detected"],
    controls.map(control => [
      control.name,
      control.mode,
      control.expectedReason,
      control.reasons.join(", ") || "nothing",
      control.detected ? "yes" : "NO",
    ]),
  );
}

/** @param {readonly LoadResult[]} results */
export function formatRoutes(results) {
  return formatTable(
    ["route", "mode", "status", "body chars", "console errors", "page errors", "third-party requests", "verdict"],
    results.map(({ path, mode, observation, pass, reasons }) => [
      path,
      mode,
      String(observation.documentStatus ?? "none"),
      String(observation.bodyTextLength),
      String(observation.consoleErrors.length),
      String(observation.pageErrors.length),
      String(observation.thirdPartyRequests.length),
      pass ? "PASS" : `FAIL (${reasons.join(", ")})`,
    ]),
  );
}

/** @param {readonly LoadResult[]} results */
export function formatThirdPartyHosts(results) {
  /** @type {Map<string, { requests: number, seenOn: Set<string> }>} */
  const hosts = new Map();

  for (const { path, mode, observation } of results) {
    for (const { host } of observation.thirdPartyRequests) {
      const entry = hosts.get(host) ?? { requests: 0, seenOn: new Set() };
      entry.requests += 1;
      entry.seenOn.add(`${path} [${mode}]`);
      hosts.set(host, entry);
    }
  }

  if (hosts.size === 0) return "Third-party hosts contacted: none";

  return [
    "Third-party hosts contacted:",
    formatTable(
      ["host", "requests", "seen on"],
      [...hosts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([host, { requests, seenOn }]) => [host, String(requests), [...seenOn].join(", ")]),
    ),
  ].join("\n");
}

/** @param {readonly LoadResult[]} results */
export function formatFailureDetails(results) {
  return results
    .filter(result => !result.pass)
    .flatMap(({ path, mode, observation }) => [
      `${path} [${mode}]`,
      ...(observation.navigationError === null ? [] : [`  navigation: ${observation.navigationError}`]),
      ...observation.consoleErrors.map(text => `  console error: ${text}`),
      ...observation.pageErrors.map(text => `  page error: ${text}`),
      ...observation.thirdPartyRequests.map(({ url }) => `  third-party request: ${url}`),
    ])
    .join("\n");
}
