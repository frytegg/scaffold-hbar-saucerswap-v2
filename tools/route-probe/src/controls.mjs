// @ts-check
import { probePage } from "./probe-page.mjs";
import { judge } from "./verdict.mjs";

/** @typedef {import("playwright").Browser} Browser */
/** @typedef {import("playwright").BrowserContext} BrowserContext */
/** @typedef {import("./modes.mjs").Mode} Mode */
/** @typedef {import("./verdict.mjs").FailureReason} FailureReason */
/** @typedef {import("./verdict.mjs").Observation} Observation */

/**
 * @typedef {object} ControlResult
 * @property {string} name
 * @property {Mode} mode
 * @property {FailureReason} expectedReason
 * @property {FailureReason[]} reasons
 * @property {boolean} detected
 */

/**
 * @typedef {object} Control
 * @property {string} name
 * @property {Mode} mode
 * @property {FailureReason} expectedReason
 * @property {RegExp} [evidence] must match one console or page error, so the planted fault is what failed the load
 * @property {string} url
 * @property {(context: BrowserContext) => Promise<unknown>} [prepare]
 */

// ".invalid" never resolves (RFC 2606): a planted request reaches no real host in any mode.
const CONTROL_URL = "https://route-probe-control.invalid/";
const CONTROL_HOST = /route-probe-control\.invalid/;
const SHORT_DOCUMENT = "<!doctype html><html><body>too short</body></html>";

/**
 * @param {BrowserContext} context
 * @param {RequestMode} requestMode
 */
function plantThirdPartyRequest(context, requestMode) {
  return context.addInitScript(({ url, mode }) => void fetch(url, { mode }), { url: CONTROL_URL, mode: requestMode });
}

/**
 * @param {Control} control
 * @param {Observation} observation
 * @param {FailureReason[]} reasons
 */
export function isDetected(control, observation, reasons) {
  if (!reasons.includes(control.expectedReason)) return false;
  const { evidence } = control;
  return (
    evidence === undefined ||
    [...observation.consoleErrors, ...observation.pageErrors].some(text => evidence.test(text))
  );
}

/**
 * Loads that MUST fail: one per detector, and one per blocking mode to show that the mode really turns a
 * third-party request into a failure the browser reports. A probe that reports any of them green is
 * blind, and its green table would mean nothing, so they run before every real probe.
 *
 * @param {Browser} browser
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.knownPath a route that exists, so only the planted fault can fail the load
 * @param {(requestUrl: string) => boolean} options.isThirdParty
 * @param {number} options.timeoutMs
 * @returns {Promise<ControlResult[]>}
 */
export async function runPositiveControls(browser, { baseUrl, knownPath, isThirdParty, timeoutMs }) {
  const knownUrl = new URL(knownPath, baseUrl).href;
  const shortDocumentUrl = new URL("/route-probe-control-short-document", baseUrl).href;

  /** @type {Control[]} */
  const controls = [
    {
      name: "console.error called by the page",
      mode: "up",
      expectedReason: "console-error",
      evidence: /route-probe positive control/,
      url: knownUrl,
      prepare: context => context.addInitScript(() => console.error("route-probe positive control")),
    },
    {
      name: "third-party request answered 204",
      mode: "up",
      expectedReason: "third-party-request",
      url: knownUrl,
      prepare: async context => {
        await context.route(`${CONTROL_URL}**`, route => route.fulfill({ status: 204 }));
        await plantThirdPartyRequest(context, "no-cors");
      },
    },
    {
      name: "document answered 404",
      mode: "up",
      expectedReason: "document-status",
      url: new URL("/route-probe-control-missing-route", baseUrl).href,
    },
    {
      name: "document with almost no text",
      mode: "up",
      expectedReason: "body-too-short",
      url: shortDocumentUrl,
      prepare: context =>
        context.route(shortDocumentUrl, route =>
          route.fulfill({ status: 200, contentType: "text/html", body: SHORT_DOCUMENT }),
        ),
    },
    {
      name: "third-party request in abort mode",
      mode: "abort",
      expectedReason: "console-error",
      evidence: CONTROL_HOST,
      url: knownUrl,
      prepare: context => plantThirdPartyRequest(context, "cors"),
    },
    {
      name: "third-party request in throttle mode",
      mode: "throttle",
      expectedReason: "console-error",
      evidence: CONTROL_HOST,
      url: knownUrl,
      prepare: context => plantThirdPartyRequest(context, "cors"),
    },
  ];

  return Promise.all(
    controls.map(async control => {
      const { name, mode, expectedReason, url, prepare } = control;
      const observation = await probePage(browser, { url, mode, isThirdParty, settleMs: 0, timeoutMs, prepare });
      const { reasons } = judge(observation);
      return { name, mode, expectedReason, reasons, detected: isDetected(control, observation, reasons) };
    }),
  );
}
