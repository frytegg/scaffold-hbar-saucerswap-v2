import { SAMPLE_ACCOUNT, runSample, sampleLines } from "../sampleRun";
import type { PlanReads } from "../swapPlan";
import { blocks } from "../swapPresentation";
import { describe, expect, it } from "vitest";
import { type EvmAddress, allowanceVerdict, costVerdict, isEvmAddress } from "~~/lib/hedera";

// The sample run is what a reader with no wallet sees. These replace its two reads, so the lines below are the
// library's own answers and nothing here touches the network.

/** What QuoterV2 answered for 1 SAUCE on 22 September 2026, and eth_gasPrice on the same day. */
const QUOTE_OUT = 21_407_500n;
const GAS_PRICE = 1_140_000_000_000n;
const NOW = 1_700_000_000_000;

function reads(allowance: bigint): { reads: PlanReads; owners: EvmAddress[] } {
  const owners: EvmAddress[] = [];
  return {
    owners,
    reads: {
      quote: () => Promise.resolve(QUOTE_OUT),
      recipient: () => Promise.reject(new Error("a token-input swap reads the allowance, never the recipient")),
      allowance: (owner, token, amountIn) => {
        owners.push(owner);
        return Promise.resolve(allowanceVerdict(allowance, amountIn, token));
      },
      cost: request =>
        Promise.resolve(
          costVerdict({
            gas: 914_509n,
            gasPrice: GAS_PRICE,
            autoAssociates: request.autoAssociates,
            token: request.token,
            hbarOut: request.hbarOut,
          }),
        ),
    },
  };
}

describe("the pre-flight a reader can run without a wallet", () => {
  it("reads the fixed sample account, which is an address and never a key", async () => {
    const { reads: fake, owners } = reads(1_000_000n);
    await runSample(fake, NOW);

    expect(owners).toEqual([SAMPLE_ACCOUNT]);
    expect(isEvmAddress(SAMPLE_ACCOUNT)).toBe(true);
  });

  it("shows the allowance refusal, with the amount to approve, when the router has none", async () => {
    const { reads: fake } = reads(0n);
    const lines = sampleLines(await runSample(fake, NOW));

    expect(blocks(lines)).toBe(true);
    const [allowance] = lines;
    expect(allowance.message).toContain("The SaucerSwap router has no allowance to spend your SAUCE.");
    expect(allowance.actionLabel).toBe("Approve 1 SAUCE for the router");
  });

  it("shows the fee preview instead once the allowance covers the amount", async () => {
    const { reads: fake } = reads(1_000_000n);
    const lines = sampleLines(await runSample(fake, NOW));

    expect(blocks(lines)).toBe(false);
    expect(lines[lines.length - 1].message).toContain("Network fee: up to");
  });

  it("shows a stage that refused as one line, so a quoter that is down reads like any other answer", async () => {
    const { reads: fake } = reads(0n);
    const down: PlanReads = { ...fake, quote: () => Promise.reject(new Error("execution reverted")) };
    const lines = sampleLines(await runSample(down, NOW));

    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("execution reverted");
  });
});
