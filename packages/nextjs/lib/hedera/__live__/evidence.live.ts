import { checkEvidence } from "../evidence";
import { readEvidence, testnetMirror } from "./testnet";
import { describe, expect, it } from "vitest";

const recorded = readEvidence();

describe("every file of docs/evidence/ matches the mirror node", () => {
  it("docs/evidence/ holds at least one record", () => {
    expect(recorded.length).toBeGreaterThan(0);
  });

  it.each(recorded.map(({ file, record }) => [file, record] as const))(
    "%s: SUCCESS, sent by the recorded account, same figures",
    async (_file, record) => {
      expect(await checkEvidence(record, testnetMirror)).toEqual([]);
    },
  );
});
