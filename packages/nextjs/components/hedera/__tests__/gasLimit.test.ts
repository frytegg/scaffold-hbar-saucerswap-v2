import { withRuleGasLimit } from "../gasLimit";
import { describe, expect, it } from "vitest";
import { buildApproveCall, gasRuleFor, positionManagerAbi, swapRouterAbi, testnet } from "~~/lib/hedera";

// The rule this route inherits is the position manager's mint, which both simulators refuse to price. Its limit is
// in lib/hedera/gasRules.ts with the two executions it comes from; nothing below repeats the number.

const MINT_RULE = gasRuleFor(testnet.positionManager.evmAddress, ["mint"]);

const multicall = (address: (typeof testnet.positionManager)["evmAddress"]) =>
  ({ address, abi: positionManagerAbi, functionName: "multicall", args: [[]] }) as const;

describe("every call a route builds asks the gas rules", () => {
  it("leaves a call the network prices exactly as the builder made it", () => {
    const call = buildApproveCall(testnet.sauce, 1_000_000n);
    expect(withRuleGasLimit(call)).toEqual(call);
    expect("gas" in withRuleGasLimit(call)).toBe(false);
  });

  it("carries the rule's own limit for a call no simulator will price", () => {
    expect(MINT_RULE).not.toBeNull();
    const call = withRuleGasLimit(multicall(testnet.positionManager.evmAddress), {
      functions: ["mint", "refundETH"],
    });
    expect(call.gas).toBe(MINT_RULE?.gasLimit);
  });

  it("matches the rule on the inner functions, so a plain multicall is not given a mint's limit", () => {
    const call = withRuleGasLimit(multicall(testnet.positionManager.evmAddress), { functions: ["collect"] });
    expect("gas" in call).toBe(false);
  });

  it("lets a caller's own limit win over the rule's", () => {
    const call = withRuleGasLimit(multicall(testnet.positionManager.evmAddress), {
      functions: ["mint"],
      gas: 1_234_567n,
    });
    expect(call.gas).toBe(1_234_567n);
  });

  it("does not give the router a limit the rules never measured for it", () => {
    const call = withRuleGasLimit(
      { address: testnet.swapRouter.evmAddress, abi: swapRouterAbi, functionName: "multicall", args: [[]] },
      { functions: ["exactInput", "refundETH"] },
    );
    expect("gas" in call).toBe(false);
  });
});
