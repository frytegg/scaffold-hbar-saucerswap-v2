// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDetected } from "../src/controls.mjs";

/** @typedef {import("../src/controls.mjs").Control} Control */
/** @typedef {import("../src/verdict.mjs").Observation} Observation */

/** @type {Control} */
const abortControl = {
  name: "third-party request in abort mode",
  mode: "abort",
  expectedReason: "console-error",
  evidence: /route-probe-control\.invalid/,
  url: "http://localhost:3201/",
};

/**
 * @param {Partial<Observation>} overrides
 * @returns {Observation}
 */
function observation(overrides) {
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

describe("isDetected", () => {
  it("accepts a control that failed for the planted reason, with the planted evidence", () => {
    const observed = observation({
      consoleErrors: ["Failed to load resource: net::ERR_FAILED (https://route-probe-control.invalid/)"],
    });
    assert.equal(isDetected(abortControl, observed, ["console-error"]), true);
  });

  it("does not credit the control with a console error the page logged for another reason", () => {
    const observed = observation({
      consoleErrors: ["Failed to load resource: net::ERR_FAILED (http://localhost:3201/x)"],
    });
    assert.equal(isDetected(abortControl, observed, ["console-error"]), false);
  });

  it("finds the evidence in an uncaught exception as well", () => {
    const observed = observation({ pageErrors: ["TypeError: Failed to fetch (route-probe-control.invalid)"] });
    assert.equal(isDetected(abortControl, observed, ["console-error", "page-error"]), true);
  });

  it("rejects a control that failed, but not with the reason it was planted for", () => {
    const observed = observation({ pageErrors: ["TypeError: Failed to fetch (route-probe-control.invalid)"] });
    assert.equal(isDetected(abortControl, observed, ["page-error"]), false);
  });

  it("needs only the reason when a control declares no evidence", () => {
    /** @type {Control} */
    const statusControl = { name: "document answered 404", mode: "up", expectedReason: "document-status", url: "/x" };
    assert.equal(isDetected(statusControl, observation({ documentStatus: 404 }), ["document-status"]), true);
  });
});
