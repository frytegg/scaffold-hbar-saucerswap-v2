// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MIN_BODY_TEXT_LENGTH, judge } from "../src/verdict.mjs";

/** @typedef {import("../src/verdict.mjs").Observation} Observation */

/**
 * @param {Partial<Observation>} [overrides]
 * @returns {Observation}
 */
function cleanLoad(overrides = {}) {
  return {
    documentStatus: 200,
    navigationError: null,
    consoleErrors: [],
    pageErrors: [],
    bodyTextLength: 743,
    thirdPartyRequests: [],
    ...overrides,
  };
}

describe("judge", () => {
  it("passes a clean load", () => {
    assert.deepEqual(judge(cleanLoad()), { pass: true, reasons: [] });
  });

  it("fails on a single console error", () => {
    const verdict = judge(cleanLoad({ consoleErrors: ["Failed to load resource: net::ERR_FAILED"] }));
    assert.deepEqual(verdict, { pass: false, reasons: ["console-error"] });
  });

  it("fails on an uncaught exception", () => {
    assert.deepEqual(judge(cleanLoad({ pageErrors: ["HttpRequestError: HTTP request failed."] })).reasons, [
      "page-error",
    ]);
  });

  it("accepts redirects and any status under 400, rejects 400 and above", () => {
    assert.equal(judge(cleanLoad({ documentStatus: 307 })).pass, true);
    assert.equal(judge(cleanLoad({ documentStatus: 399 })).pass, true);
    assert.deepEqual(judge(cleanLoad({ documentStatus: 400 })).reasons, ["document-status"]);
    assert.deepEqual(judge(cleanLoad({ documentStatus: 404 })).reasons, ["document-status"]);
    assert.deepEqual(judge(cleanLoad({ documentStatus: 500 })).reasons, ["document-status"]);
  });

  it("treats a load without any document response as a failed navigation, not as a bad status", () => {
    assert.deepEqual(judge(cleanLoad({ documentStatus: null })).reasons, ["navigation-failed"]);
  });

  it("fails a navigation that never went idle, even though its document answered 200", () => {
    const verdict = judge(cleanLoad({ navigationError: "page.goto: Timeout 60000ms exceeded." }));
    assert.deepEqual(verdict.reasons, ["navigation-failed"]);
  });

  it(`requires ${MIN_BODY_TEXT_LENGTH} characters of body text`, () => {
    assert.deepEqual(judge(cleanLoad({ bodyTextLength: MIN_BODY_TEXT_LENGTH - 1 })).reasons, ["body-too-short"]);
    assert.equal(judge(cleanLoad({ bodyTextLength: MIN_BODY_TEXT_LENGTH })).pass, true);
  });

  it("fails on a third-party request even when that request succeeded silently", () => {
    const verdict = judge(
      cleanLoad({ thirdPartyRequests: [{ host: "api.example.com", url: "https://api.example.com/v3/price" }] }),
    );
    assert.deepEqual(verdict, { pass: false, reasons: ["third-party-request"] });
  });

  it("reports every reason of a load that fails several ways", () => {
    const verdict = judge(
      cleanLoad({
        documentStatus: 500,
        consoleErrors: ["boom"],
        pageErrors: ["boom"],
        bodyTextLength: 0,
        thirdPartyRequests: [{ host: "api.example.com", url: "https://api.example.com/" }],
      }),
    );
    assert.deepEqual(verdict.reasons, [
      "document-status",
      "console-error",
      "page-error",
      "body-too-short",
      "third-party-request",
    ]);
  });
});
