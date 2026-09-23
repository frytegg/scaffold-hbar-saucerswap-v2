import { type ReplayBlock, type ReplayBlockId, replayBehaviours } from "../__live__/replayCaptured";
import { testnet } from "../addresses";
import { explainError, explainResponseCode } from "../failure";
import { GAS_RULES_MODULE, gasRules, largestMeasuredGas } from "../gasRules";
import { allowanceVerdict, facadeResultVerdict } from "../preflight";
import { walletErrorRecord } from "./replay";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// What the zero-setup command decides: which captured answer produces which sentence, and where each sentence
// comes from. The rule this file enforces is that the command writes none of them: every quoted sentence has to be
// the library's own output for the same input, so the report cannot drift from what the app shows a user.

const FIXTURES = new URL("./fixtures/", import.meta.url);

/** Reads the blocks once with a global fetch that throws: a request leaving this process fails the whole file. */
const offline = vi.fn<typeof fetch>(() => {
  throw new Error("the replay reached the network");
});
const blocks = await (async () => {
  const real = globalThis.fetch;
  globalThis.fetch = offline;
  try {
    return await replayBehaviours();
  } finally {
    globalThis.fetch = real;
  }
})();

function block(id: ReplayBlockId): ReplayBlock {
  const found = blocks.find(candidate => candidate.id === id);
  if (found === undefined) throw new Error(`no block ${id}`);
  return found;
}

/** The line whose label is `label`, which is what ties a decision to the place the report shows it. */
function line(id: ReplayBlockId, half: "tooling" | "template", label: string): { text: string; says?: string } {
  const found = block(id)[half].find(candidate => candidate.label.startsWith(label));
  if (found === undefined) throw new Error(`no ${half} line "${label}" in ${id}`);
  return found;
}

describe("the replay runs on captured answers alone", () => {
  it("builds the three behaviours without one request leaving the process", () => {
    expect(blocks.map(({ id }) => id)).toEqual(["allowance", "not-estimable", "response-code"]);
    expect(offline).toHaveBeenCalledTimes(0);
  });

  it("names captured files that exist, and nothing else", () => {
    for (const { id, fixtures } of blocks) {
      expect(fixtures.length, id).toBeGreaterThan(0);
      for (const fixture of fixtures) expect(existsSync(new URL(fixture, FIXTURES)), `${id}: ${fixture}`).toBe(true);
    }
  });

  it("gives every transaction it shows both links, never one alone", () => {
    for (const { id, proof } of blocks) {
      expect(proof.length, id).toBeGreaterThan(0);
      for (const { hash, mirrorUrl, hashscanUrl } of proof) {
        expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(mirrorUrl).toBe(`https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${hash}`);
        expect(hashscanUrl).toBe(`https://hashscan.io/testnet/tx/${hash}`);
      }
    }
  });
});

describe("the swap the simulators accepted", () => {
  it("quotes the pre-flight's own refusal of the captured allowance of 0, for the captured amount of 10 SAUCE", () => {
    expect(line("allowance", "template", "before the send").says).toBe(
      allowanceVerdict(0n, 10_000_000n, testnet.sauce).message,
    );
  });

  it("quotes the decoder's answer for the 292 the mirror node's /actions hold", () => {
    const afterwards = line("allowance", "template", "if it is sent");
    expect(afterwards.says).toBe(explainResponseCode(292, "replay").message);
    expect(afterwards.text).toContain("292 SPENDER_DOES_NOT_HAVE_ALLOWANCE");
  });

  it("reports what the wallet showed and what the account paid, from the captured session", () => {
    expect(line("allowance", "tooling", "MetaMask").text).toContain("1.0912 HBAR");
    expect(line("allowance", "tooling", "afterwards").text).toContain("0.13498778 HBAR");
    expect(line("allowance", "tooling", "eth_estimateGas").text).toContain("957,076 gas");
  });

  it("shows the wallet's own swap first, and the script's run of the same miss beside it", () => {
    expect(block("allowance").proof.map(({ hash }) => hash)).toEqual([
      "0xdf368443228e69c4ed1a2a7192d0978b15a51f219981cdd2d5f63250d1582352",
      "0x756bfe6431ace6935b49bd415b53a2e29cee7b8df1f863adafe42b101e88dabc",
    ]);
  });
});

describe("the call no simulator prices", () => {
  const rule = gasRules[0];

  it("refuses to build it before anything is sent, quoting the limit and the largest execution", () => {
    const refusal = line("not-estimable", "template", "before the send");
    expect(refusal.text).toContain("supply-gas");
    expect(refusal.says).toContain(String(rule.gasLimit));
    expect(refusal.says).toContain(String(largestMeasuredGas(rule)));
    expect(refusal.says).toContain(GAS_RULES_MODULE);
  });

  it("reads the wallet's own refusal as a missing gas limit, for the call the rule covers", () => {
    const advised = line("not-estimable", "template", "if a wallet refuses");
    expect(advised.says).toBe(
      explainError(walletErrorRecord("metamask-send-refused-no-gas-limit").error, {
        address: testnet.positionManager.evmAddress,
        functions: ["mint", "refundETH"],
      }).message,
    );
    expect(advised.text).toContain("not-estimable");
  });

  it("does not ask for a gas limit for a call no rule covers: that would be a transaction the network refuses", () => {
    const control = line("not-estimable", "template", "and the control");
    expect(control.text).toContain("rpc-refusal");
    expect(control.text).not.toContain("not-estimable");
    expect(control.says).toBeUndefined();
  });
});

describe("the response code inside a successful transaction", () => {
  it("has nothing for the failure path to report, which is the whole trap", () => {
    expect(line("response-code", "template", "the failure path").text).toContain("nothing to report");
    expect(line("response-code", "tooling", "the receipt").text).toContain("status 0x1");
  });

  it("quotes the facade verdict for the 194 the captured return value holds", () => {
    const value = line("response-code", "template", "the return value");
    expect(value.says).toBe(facadeResultVerdict(194n).message);
    expect(value.text).toContain("reads the 194");
  });
});
