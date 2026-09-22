// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatFailureDetails, formatTable, formatThirdPartyHosts } from "../src/report.mjs";

/** @typedef {import("../src/report.mjs").LoadResult} LoadResult */

/**
 * @param {Pick<LoadResult, "path" | "mode">} where
 * @param {Partial<LoadResult["observation"]>} [observed]
 * @returns {LoadResult}
 */
function result(where, observed = {}) {
  const observation = {
    documentStatus: 200,
    navigationError: null,
    consoleErrors: [],
    pageErrors: [],
    bodyTextLength: 743,
    thirdPartyRequests: [],
    ...observed,
  };
  const failed = observation.consoleErrors.length > 0 || observation.thirdPartyRequests.length > 0;
  return { ...where, observation, pass: !failed, reasons: failed ? ["console-error"] : [] };
}

describe("formatTable", () => {
  it("pads every column to its widest cell", () => {
    assert.equal(
      formatTable(["route", "mode"], [["/debug", "up"]]),
      ["route   mode", "------  ----", "/debug  up"].join("\n"),
    );
  });
});

describe("formatThirdPartyHosts", () => {
  it("says so explicitly when no third party was contacted", () => {
    assert.equal(formatThirdPartyHosts([result({ path: "/", mode: "up" })]), "Third-party hosts contacted: none");
  });

  it("counts requests per host and names every load that made one", () => {
    const price = { host: "api.example.com", url: "https://api.example.com/v3/price" };
    const report = formatThirdPartyHosts([
      result({ path: "/", mode: "up" }, { thirdPartyRequests: [price, price] }),
      result({ path: "/debug", mode: "abort" }, { thirdPartyRequests: [price] }),
    ]);
    assert.match(report, /api\.example\.com\s+3\s+\/ \[up\], \/debug \[abort\]/);
  });
});

describe("formatFailureDetails", () => {
  it("is empty when every load passed", () => {
    assert.equal(formatFailureDetails([result({ path: "/", mode: "up" })]), "");
  });

  it("prints the evidence of each failed load under its route and mode", () => {
    const details = formatFailureDetails([
      result({ path: "/", mode: "up" }),
      result({ path: "/debug", mode: "abort" }, { consoleErrors: ["Failed to load resource: net::ERR_FAILED"] }),
    ]);
    assert.equal(details, "/debug [abort]\n  console error: Failed to load resource: net::ERR_FAILED");
  });
});
