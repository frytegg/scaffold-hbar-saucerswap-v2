// @ts-check

export const MIN_BODY_TEXT_LENGTH = 20;

/**
 * @typedef {object} ThirdPartyRequest
 * @property {string} host
 * @property {string} url
 */

/**
 * What one page load showed.
 * @typedef {object} Observation
 * @property {number | null} documentStatus HTTP status of the document, null when the navigation got no response
 * @property {string | null} navigationError
 * @property {string[]} consoleErrors
 * @property {string[]} pageErrors uncaught exceptions
 * @property {number} bodyTextLength
 * @property {ThirdPartyRequest[]} thirdPartyRequests
 */

/**
 * @typedef {"navigation-failed" | "document-status" | "console-error" | "page-error" | "body-too-short" | "third-party-request"} FailureReason
 */

/**
 * A third-party request fails the load in every mode, not only when it goes wrong: a request that
 * succeeds today is the console error of the day its host rate-limits the visitor.
 *
 * @param {Observation} observation
 * @returns {{ pass: boolean, reasons: FailureReason[] }}
 */
export function judge(observation) {
  /** @type {FailureReason[]} */
  const reasons = [];

  if (observation.navigationError !== null || observation.documentStatus === null) reasons.push("navigation-failed");
  if (observation.documentStatus !== null && observation.documentStatus >= 400) reasons.push("document-status");
  if (observation.consoleErrors.length > 0) reasons.push("console-error");
  if (observation.pageErrors.length > 0) reasons.push("page-error");
  if (observation.bodyTextLength < MIN_BODY_TEXT_LENGTH) reasons.push("body-too-short");
  if (observation.thirdPartyRequests.length > 0) reasons.push("third-party-request");

  return { pass: reasons.length === 0, reasons };
}
