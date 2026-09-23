import { testnet } from "../addresses";
import { toEvmAddress } from "../evmAddress";
import { GasRuleError } from "../gasRules";
import {
  MINT_FEE_MARGIN_BPS,
  PositionBuildError,
  buildBurn,
  buildDecreaseLiquidity,
  buildManagerTokenApproval,
  buildNftApproval,
  buildPositionMint,
  buildSplitCollect,
  mintValue,
  orderPoolTokens,
  positionMintGasLimit,
} from "../position";
import { positionManagerAbi } from "../positionAbi";
import { WEIBAR_PER_TINYBAR, tinybar } from "../units";
import { type LifecycleFixture, type LifecycleStepFixture, positionFixture, rpcFixture } from "./replay";
import { type Hex, decodeAbiParameters, decodeFunctionData, encodeFunctionData, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";

// Each builder is checked against the calldata of the transaction that did the same thing on Hedera testnet: the
// arguments are decoded out of the recorded bytes, handed back to the builder, and the bytes it returns must be the
// same. A wrong field order, a wrong name or a missing inner call fails here instead of on chain.

const lifecycle = positionFixture<LifecycleFixture>("serial-360-lifecycle");
const step = (name: LifecycleStepFixture["step"]): LifecycleStepFixture => {
  const found = lifecycle.transactions.find(transaction => transaction.step === name);
  if (found === undefined) throw new Error(`the life-cycle fixture holds the ${name}`);
  return found;
};

const MINT_FEE_TINYBAR = tinybar(
  decodeAbiParameters(parseAbiParameters("uint256"), rpcFixture("call-tinycents-to-tinybars").body.result as Hex)[0],
);

const callData = (call: { abi: typeof positionManagerAbi; functionName: string; args: readonly unknown[] }): Hex =>
  encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as never);

/** The inner calls of a multicall, in order, whether it was recorded or just built. */
function innerCallsIn(data: Hex): readonly Hex[] {
  const decoded = decodeFunctionData({ abi: positionManagerAbi, data });
  if (decoded.functionName !== "multicall") throw new Error("this call is a multicall");
  return decoded.args[0];
}

const innerCalls = (transaction: LifecycleStepFixture): readonly Hex[] => innerCallsIn(transaction.functionParameters);
const innerCallsOf = (call: Parameters<typeof callData>[0]): readonly Hex[] => innerCallsIn(callData(call));

function decodedMintParams() {
  const decoded = decodeFunctionData({ abi: positionManagerAbi, data: innerCalls(step("mint"))[0] });
  if (decoded.functionName !== "mint") throw new Error("the first inner call of the mint is the mint");
  return decoded.args[0];
}

describe("the mint, against the transaction that opened position 360", () => {
  const recorded = decodedMintParams();

  const build = (overrides: Partial<Parameters<typeof buildPositionMint>[0]> = {}) =>
    buildPositionMint({
      pool: testnet.hbarSaucePool,
      recipient: toEvmAddress(recorded.recipient),
      range: { tickLower: recorded.tickLower, tickUpper: recorded.tickUpper },
      tickSpacing: 60,
      hbarAmount: tinybar(recorded.amount0Desired),
      tokenAmount: recorded.amount1Desired,
      minimums: { amount0Min: recorded.amount0Min, amount1Min: recorded.amount1Min, acceptAnyPrice: true },
      deadline: recorded.deadline,
      mintFeeTinybar: MINT_FEE_TINYBAR,
      gas: positionMintGasLimit(),
      ...overrides,
    });

  it("rebuilds the calldata the wallet sent, multicall, mint and refundETH included", () => {
    expect(callData(build())).toBe(step("mint").functionParameters);
  });

  it("carries the value that transaction carried: the HBAR leg, the fee and the margin", () => {
    expect(build().value).toBe(BigInt(step("mint").valueTinybar) * WEIBAR_PER_TINYBAR);
    expect(
      mintValue({
        hbarAmount: tinybar(recorded.amount0Desired),
        mintFeeTinybar: MINT_FEE_TINYBAR,
        marginBps: MINT_FEE_MARGIN_BPS,
      }),
    ).toBe(BigInt(step("mint").valueTinybar));
  });

  it("refuses to be built without a gas limit, because no simulator will price a mint", () => {
    const refusal = (): unknown => build({ gas: undefined });
    expect(refusal).toThrow(GasRuleError);
    expect(refusal).toThrow(/CONTRACT_REVERT_EXECUTED, INVALID_NFT_ID/);
    expect(refusal).toThrow(/gasRules\.ts/);
    expect(build().gas).toBe(positionMintGasLimit());
  });

  it("sends a limit above the gas that mint used and below the one the wallet was given", () => {
    expect(positionMintGasLimit()).toBeGreaterThan(BigInt(step("mint").gasUsed));
    expect(positionMintGasLimit()).toBeLessThan(BigInt(step("mint").gasLimit));
  });

  it("widens the range to the pool's spacing rather than sending a tick the pool refuses", () => {
    const widened = build({ range: { tickLower: -7650, tickUpper: -7630 } });
    expect(callData(widened)).toBe(step("mint").functionParameters);
  });

  it("puts the HBAR side where the pool holds it, which is decided by the two addresses", () => {
    const { token0, token1, hbarIsToken0 } = orderPoolTokens(testnet.hbarSaucePool);
    expect(hbarIsToken0).toBe(true);
    expect(token0.evmAddress).toBe(testnet.whbar.evmAddress);
    expect(token1.evmAddress).toBe(testnet.sauce.evmAddress);
    expect(recorded.token0.toLowerCase()).toBe(testnet.whbar.evmAddress.toLowerCase());
    const built = decodeFunctionData({ abi: positionManagerAbi, data: innerCallsOf(build())[0] });
    if (built.functionName !== "mint") throw new Error("the builder puts the mint first");
    expect(built.args[0].amount0Desired).toBe(recorded.amount0Desired);
    expect(built.args[0].amount1Desired).toBe(recorded.amount1Desired);
  });

  it("refuses a mint with no minimum on either side unless the caller says so", () => {
    const refusal = (): unknown => build({ minimums: { amount0Min: 0n, amount1Min: 0n } });
    expect(refusal).toThrow(PositionBuildError);
    expect(refusal).toThrow(/accepts whatever price the pool is at/);
  });

  it("refuses amounts a Hedera token cannot carry, and a mint that offers nothing", () => {
    expect(() => build({ tokenAmount: 2n ** 63n })).toThrow(/HTS amounts are int64/);
    expect(() => build({ hbarAmount: tinybar(0n), tokenAmount: 0n })).toThrow(/at least one of the tokens/);
    expect(() => build({ marginBps: 10_001 })).toThrow(/basis points/);
  });
});

describe("the close, against the three transactions that emptied position 360", () => {
  it("rebuilds the decreaseLiquidity the wallet sent", () => {
    const decoded = decodeFunctionData({ abi: positionManagerAbi, data: step("decrease").functionParameters });
    if (decoded.functionName !== "decreaseLiquidity") throw new Error("the decrease is a decreaseLiquidity");
    const recorded = decoded.args[0];
    const call = buildDecreaseLiquidity({
      tokenId: recorded.tokenId,
      liquidity: recorded.liquidity,
      minimums: { amount0Min: recorded.amount0Min, amount1Min: recorded.amount1Min, acceptAnyPrice: true },
      deadline: recorded.deadline,
    });
    expect(callData(call)).toBe(step("decrease").functionParameters);
    expect(call.value).toBeUndefined();
  });

  it("rebuilds the split collect, whose three calls are what deliver native HBAR", () => {
    const recorded = innerCalls(step("collect"));
    const last = decodeFunctionData({ abi: positionManagerAbi, data: recorded[2] });
    if (last.functionName !== "collect") throw new Error("the last inner call of the collect is a collect");
    const { tokenId, recipient } = last.args[0];
    expect(callData(buildSplitCollect({ tokenId, recipient: toEvmAddress(recipient) }))).toBe(
      step("collect").functionParameters,
    );
    // The control: the recipient really is in those bytes, so the rebuild above is not matching by accident.
    expect(callData(buildSplitCollect({ tokenId, recipient: testnet.swapRouter.evmAddress }))).not.toBe(
      step("collect").functionParameters,
    );
  });

  it("sends the wrapped HBAR to the manager first, because collecting both sides at once reverts", () => {
    const recorded = innerCalls(step("collect"));
    expect(recorded).toHaveLength(3);
    const collected = decodeFunctionData({ abi: positionManagerAbi, data: recorded[0] });
    if (collected.functionName !== "collect") throw new Error("the first inner call of the collect is a collect");
    expect(collected.args[0].recipient).toBe("0x0000000000000000000000000000000000000000");
    expect(collected.args[0].amount1Max).toBe(0n);
    expect(decodeFunctionData({ abi: positionManagerAbi, data: recorded[1] }).functionName).toBe("unwrapWHBAR");
  });

  it("rebuilds the burn, and refuses to build one while the manager holds no approval", () => {
    const decoded = decodeFunctionData({ abi: positionManagerAbi, data: step("burn").functionParameters });
    if (decoded.functionName !== "burn") throw new Error("the burn is a burn");
    const tokenId = decoded.args[0];
    expect(callData(buildBurn({ tokenId, approvedForAll: true }))).toBe(step("burn").functionParameters);
    const refusal = (): unknown => buildBurn({ tokenId, approvedForAll: false });
    expect(refusal).toThrow(PositionBuildError);
    expect(refusal).toThrow(/HederaFail\(292\)/);
    expect(refusal).toThrow(/setApprovalForAll/);
  });
});

describe("the two approvals a position needs", () => {
  it("approves the position manager on the pool's token, not the router", () => {
    const call = buildManagerTokenApproval(testnet.sauce, 20_000_000n);
    expect(call.address).toBe(testnet.sauce.evmAddress);
    expect(call.args[0]).toBe(testnet.positionManager.evmAddress);
    expect(() => buildManagerTokenApproval(testnet.sauce, 0n)).toThrow(/lets the manager pull none/);
  });

  it("approves the manager on the position NFT facade, and can take it back", () => {
    expect(buildNftApproval(true)).toEqual({
      address: testnet.lpNft.evmAddress,
      abi: expect.anything(),
      functionName: "setApprovalForAll",
      args: [testnet.positionManager.evmAddress, true],
    });
    expect(buildNftApproval(false).args[1]).toBe(false);
  });
});
