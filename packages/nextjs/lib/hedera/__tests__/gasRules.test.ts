import { testnet } from "../addresses";
import { isEvmAddress } from "../evmAddress";
import { GAS_RULES_MODULE, GasRuleError, gasRuleFor, gasRules, largestMeasuredGas, withGasLimit } from "../gasRules";
import { buildHbarToTokenSwap } from "../swap";
import { hbarToTinybar } from "../units";
import { describe, expect, it } from "vitest";

const MAIN = "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01";
const MINT = {
  address: testnet.positionManager.evmAddress,
  abi: [],
  functionName: "multicall",
  args: [[]],
} as const;

const swap = buildHbarToTokenSwap({
  pool: testnet.hbarSaucePool,
  recipient: MAIN,
  slippageBps: 500,
  deadline: 1_790_200_000n,
  amountIn: hbarToTinybar("1"),
  quotedAmountOut: 46_434_742n,
});

describe("the calls Hedera will not price", () => {
  it("a position mint has a rule, whichever case the address is written in", () => {
    const rule = gasRuleFor(testnet.positionManager.evmAddress, ["mint"]);
    expect(rule?.simulatorAnswer).toBe("CONTRACT_REVERT_EXECUTED, INVALID_NFT_ID");
    const lowercase: string = testnet.positionManager.evmAddress.toLowerCase();
    if (!isEvmAddress(lowercase, { strict: false })) throw new Error("the address book holds an address");
    expect(gasRuleFor(lowercase, ["mint"])).toBe(rule);
  });

  it("a multicall is named by the function inside it, not by multicall", () => {
    expect(gasRuleFor(testnet.positionManager.evmAddress, ["mint", "refundETH"])).not.toBeNull();
    expect(gasRuleFor(testnet.positionManager.evmAddress, ["multicall"])).toBeNull();
  });

  it("a swap through the router has none: the relay estimates it", () => {
    expect(gasRuleFor(testnet.swapRouter.evmAddress, ["multicall", "exactInput"])).toBeNull();
  });

  it("every rule's limit leaves room above every execution it records", () => {
    for (const rule of gasRules) {
      expect(rule.measurements.length).toBeGreaterThan(0);
      expect(rule.gasLimit).toBeGreaterThan(largestMeasuredGas(rule));
      for (const measurement of rule.measurements) {
        expect(measurement.hash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(measurement.mirrorUrl).toContain(measurement.hash);
      }
    }
  });

  it("counts the mint this template's own command sent, which is the largest of the three", () => {
    const rule = gasRuleFor(testnet.positionManager.evmAddress, ["mint"]);
    if (rule === null) throw new Error("the mint has a rule");
    // docs/evidence/2026-09-23-position-cycle-361.json, re-read from the mirror node by yarn evidence:check.
    expect(rule.measurements).toContainEqual(
      expect.objectContaining({
        gasUsed: 761_531n,
        hash: "0xac5b06097841d492cad222545bd01eddc837099040bd1d5e5bb3abfd1e85d017",
        sentBy: "yarn evidence:position, gas limit 1,000,000",
      }),
    );
    expect(largestMeasuredGas(rule)).toBe(761_531n);
  });
});

describe("withGasLimit refuses to build a call nothing can price without one", () => {
  it("throws, names the answer the simulators give, the limit to use and where the rules are", () => {
    const refusal = (): unknown => withGasLimit(MINT, { functions: ["mint", "refundETH"] });
    expect(refusal).toThrow(GasRuleError);
    expect(refusal).toThrow(/cannot be estimated on Hedera/);
    expect(refusal).toThrow(/CONTRACT_REVERT_EXECUTED, INVALID_NFT_ID/);
    expect(refusal).toThrow(/Pass gas: this template sends 1000000, above the 761531 gas/);
    expect(refusal).toThrow(new RegExp(GAS_RULES_MODULE.replace(/\//g, "\\/")));
    try {
      withGasLimit(MINT, { functions: ["mint"] });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GasRuleError);
      expect((error as GasRuleError).code).toBe("missing-gas-limit");
      expect((error as GasRuleError).rule.gasLimit).toBe(1_000_000n);
    }
  });

  it("adds the limit the caller supplies", () => {
    const rule = gasRuleFor(testnet.positionManager.evmAddress, ["mint"]);
    expect(withGasLimit(MINT, { functions: ["mint"], gas: rule?.gasLimit })).toMatchObject({ gas: 1_000_000n });
  });

  it("leaves a call the relay prices exactly as it was", () => {
    expect(withGasLimit(swap)).toBe(swap);
    expect(withGasLimit(swap, { gas: 300_000n })).toMatchObject({ ...swap, gas: 300_000n });
  });
});
