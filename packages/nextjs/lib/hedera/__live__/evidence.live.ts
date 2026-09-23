import { type EvidenceRecord, type PositionEvidenceRecord, checkEvidence, checkPositionEvidence } from "../evidence";
import { readEvidence, testnetMirror } from "./testnet";
import { describe, expect, it } from "vitest";

const recorded = readEvidence();

/** A record carries either a swap or a position, and each is re-read against the mirror node by its own checker. */
function check(record: EvidenceRecord | PositionEvidenceRecord): Promise<string[]> {
  return "position" in record ? checkPositionEvidence(record, testnetMirror) : checkEvidence(record, testnetMirror);
}

describe("every file of docs/evidence/ matches the mirror node", () => {
  it("docs/evidence/ holds at least one record", () => {
    expect(recorded.length).toBeGreaterThan(0);
  });

  it.each(recorded.map(({ file, record }) => [file, record] as const))(
    "%s: SUCCESS, sent by the recorded account, same figures",
    async (_file, record) => {
      expect(await check(record)).toEqual([]);
    },
  );
});
