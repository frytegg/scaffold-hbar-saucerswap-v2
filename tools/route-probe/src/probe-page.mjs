// @ts-check
import { createThrottle } from "./modes.mjs";

/** @typedef {import("playwright").Browser} Browser */
/** @typedef {import("playwright").BrowserContext} BrowserContext */
/** @typedef {import("playwright").ConsoleMessage} ConsoleMessage */
/** @typedef {import("./modes.mjs").Mode} Mode */
/** @typedef {import("./verdict.mjs").Observation} Observation */

/**
 * @typedef {object} PageProbe
 * @property {string} url
 * @property {Mode} mode
 * @property {(requestUrl: string) => boolean} isThirdParty
 * @property {number} settleMs how long the page is watched after the network went idle
 * @property {number} timeoutMs
 * @property {(context: BrowserContext) => Promise<unknown>} [prepare] runs before the page exists
 */

/**
 * @param {BrowserContext} context
 * @param {Exclude<Mode, "up">} mode
 * @param {(requestUrl: string) => boolean} isThirdParty
 * @param {(requestUrl: string) => void} recordThirdParty
 */
async function blockThirdParties(context, mode, isThirdParty, recordThirdParty) {
  const throttle = createThrottle();

  await context.route(
    url => isThirdParty(url.href),
    async route => {
      if (mode === "abort") {
        await route.abort();
        return;
      }
      const status = throttle(new URL(route.request().url()).host);
      await route.fulfill({
        status,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ error: `route-probe answered ${status}` }),
      });
    },
  );

  // A routed WebSocket never reaches the network and raises no "websocket" page event,
  // so this handler is the only place that sees it.
  await context.routeWebSocket(
    url => isThirdParty(url.href),
    async socket => {
      recordThirdParty(socket.url());
      await socket.close();
    },
  );
}

/** @param {ConsoleMessage} message */
function describeConsoleError(message) {
  const { url } = message.location();
  return url ? `${message.text()} (${url})` : message.text();
}

/**
 * Loads one URL in a fresh browser context, so no storage, cache or wallet session carries over.
 *
 * @param {Browser} browser
 * @param {PageProbe} probe
 * @returns {Promise<Observation>}
 */
export async function probePage(browser, probe) {
  const context = await browser.newContext();

  try {
    /** @type {Observation["consoleErrors"]} */
    const consoleErrors = [];
    /** @type {Observation["pageErrors"]} */
    const pageErrors = [];
    /** @type {Observation["thirdPartyRequests"]} */
    const thirdPartyRequests = [];
    /** @type {number | null} */
    let documentStatus = null;
    /** @type {string | null} */
    let navigationError = null;

    /** @param {string} requestUrl */
    const recordThirdParty = requestUrl => {
      thirdPartyRequests.push({ host: new URL(requestUrl).host, url: requestUrl });
    };

    // Context level, so requests made by workers count too. A blocked request is still seen here first.
    context.on("request", request => {
      if (probe.isThirdParty(request.url())) recordThirdParty(request.url());
    });
    if (probe.mode !== "up") await blockThirdParties(context, probe.mode, probe.isThirdParty, recordThirdParty);
    await probe.prepare?.(context);

    const page = await context.newPage();
    page.on("console", message => {
      if (message.type() === "error") consoleErrors.push(describeConsoleError(message));
    });
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("response", response => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        documentStatus = response.status();
      }
    });
    if (probe.mode === "up") {
      page.on("websocket", socket => {
        if (probe.isThirdParty(socket.url())) recordThirdParty(socket.url());
      });
    }

    try {
      await page.goto(probe.url, { waitUntil: "networkidle", timeout: probe.timeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      navigationError = message.split("\n", 1)[0] ?? message;
    }

    await page.waitForTimeout(probe.settleMs);
    let bodyTextLength = 0;
    try {
      bodyTextLength = (await page.evaluate(() => document.body?.innerText ?? "")).trim().length;
    } catch (error) {
      // A crashed or closed page has no text to read; the load fails through its navigation error.
      navigationError ??= `body text unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }

    return { documentStatus, navigationError, consoleErrors, pageErrors, bodyTextLength, thirdPartyRequests };
  } finally {
    await context.close();
  }
}
