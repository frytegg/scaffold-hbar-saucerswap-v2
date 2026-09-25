import { type Tamper, type TamperRun, exitCodeOf, renderTamper, tamperCaptured } from "../__live__/tamperCaptured";
import { describe, expect, it, vi } from "vitest";

// The command that falsifies this template's own evidence has to be held to two things. It must reach no network,
// like everything else in the offline tier. And it must be able to fail: a checker that cannot report a defect is
// decoration, so the tests below build the defect it exists to find and require it to be reported.

/** Runs the alterations once with a global fetch that throws: a request leaving this process fails the file. */
const offline = vi.fn<typeof fetch>(() => {
  throw new Error("the tamper command reached the network");
});
const run = await (async () => {
  const real = globalThis.fetch;
  globalThis.fetch = offline;
  try {
    return await tamperCaptured();
  } finally {
    globalThis.fetch = real;
  }
})();

describe("altering a captured answer changes what the library says about it", () => {
  it("reaches no network", () => {
    expect(offline).not.toHaveBeenCalled();
  });

  it("alters three answers, each in a named field of a named file", () => {
    expect(run.tampers.map(tamper => tamper.id)).toEqual(["response-code", "allowance", "not-estimable"]);
    for (const tamper of run.tampers) {
      expect(tamper.fixture).toMatch(/^(mirror|rpc)\/[a-z0-9-]+\.json$/);
      expect(tamper.change.length).toBeGreaterThan(20);
    }
  });

  it("changes every sentence, which is what says the sentences are computed", () => {
    for (const tamper of run.tampers) {
      expect(tamper.captured).not.toBe(tamper.altered);
      expect(tamper.changed).toBe(true);
    }
  });

  it("reads the response code out of the data rather than naming it", () => {
    const code = run.tampers.find(tamper => tamper.id === "response-code");
    expect(code?.captured).toContain("194 (TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT)");
    // 194 became 22, and the verdict flipped with it: same code path, one byte of evidence apart.
    expect(code?.captured).toContain("fail");
    expect(code?.altered).toContain("pass");
  });

  it("follows a response code from the allowance failure to the association failure", () => {
    const allowance = run.tampers.find(tamper => tamper.id === "allowance");
    expect(allowance?.captured).toContain("approve");
    expect(allowance?.altered).toContain("associate");
  });

  it("stops calling a call un-priceable when the status that made it so is gone", () => {
    const estimable = run.tampers.find(tamper => tamper.id === "not-estimable");
    expect(estimable?.captured).toContain("not-estimable");
    expect(estimable?.altered).not.toContain("not-estimable");
  });

  it("leaves every captured file exactly as it found it", () => {
    expect(run.untouched.length).toBeGreaterThanOrEqual(4);
    for (const file of run.untouched) expect(file.after).toBe(file.before);
  });
});

describe("the command can fail, which is the only reason to trust it when it passes", () => {
  const unchanged: Tamper = {
    id: "response-code",
    title: "a sentence written by hand",
    fixture: "mirror/anything.json",
    change: "a field that should have changed the answer and did not",
    captured: "the same sentence",
    altered: "the same sentence",
    changed: false,
  };

  it("exits 0 only when every sentence followed its evidence", () => {
    expect(exitCodeOf(run)).toBe(0);
  });

  it("exits 1 when a sentence survives its evidence being falsified", () => {
    const defective: TamperRun = { tampers: [...run.tampers, unchanged], untouched: run.untouched };
    expect(exitCodeOf(defective)).toBe(1);
    expect(renderTamper(defective)).toContain("SURVIVED ITS OWN EVIDENCE BEING FALSIFIED");
  });

  it("exits 1 when a captured file moved on disk, which this command must never do", () => {
    const wrote: TamperRun = {
      tampers: run.tampers,
      untouched: [{ file: "mirror/anything.json", before: "aaaa", after: "bbbb" }],
    };
    expect(exitCodeOf(wrote)).toBe(1);
    expect(renderTamper(wrote)).toContain("CHANGED ON DISK");
  });
});

describe("the report a reader sees", () => {
  it("names every file it altered, so the reader can open it", () => {
    const report = renderTamper(run);
    for (const tamper of run.tampers) expect(report).toContain(tamper.fixture);
  });

  it("says plainly that nothing was written and nothing left the process", () => {
    const report = renderTamper(run);
    expect(report).toContain("all unchanged on disk");
    expect(report).toContain("No key, no wallet, no account, nothing signed");
  });
});
