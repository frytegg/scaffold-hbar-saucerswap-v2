// @ts-check

/**
 * up:       third parties answer for themselves
 * abort:    every third-party request fails at the network level
 * throttle: every third-party host answers 429 once, then 400
 */
export const MODES = /** @type {const} */ (["up", "abort", "throttle"]);

/** @typedef {typeof MODES[number]} Mode */

/**
 * A rate limit followed by a rejection is what a public endpoint hands a page that keeps asking:
 * the first request to a host gets 429, every later one 400.
 *
 * @returns {(host: string) => 429 | 400}
 */
export function createThrottle() {
  /** @type {Set<string>} */
  const throttledHosts = new Set();

  return host => {
    if (throttledHosts.has(host)) return 400;
    throttledHosts.add(host);
    return 429;
  };
}
