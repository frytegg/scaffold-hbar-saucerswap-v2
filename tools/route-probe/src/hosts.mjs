// @ts-check

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

/** @param {string} hostname as `URL.hostname` spells it, brackets included for IPv6 */
export function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Builds the test that separates the app under probe from everybody else. Loopback always counts as
 * local, so a probe aimed at "localhost" still treats the app's calls to 127.0.0.1 as its own.
 *
 * @param {string} baseUrl
 * @returns {(requestUrl: string) => boolean}
 */
export function createThirdPartyTest(baseUrl) {
  const baseHostname = new URL(baseUrl).hostname;

  return requestUrl => {
    if (!URL.canParse(requestUrl)) return false;
    const { protocol, hostname } = new URL(requestUrl);
    if (!NETWORK_PROTOCOLS.has(protocol)) return false;
    return hostname !== baseHostname && !isLoopbackHostname(hostname);
  };
}
