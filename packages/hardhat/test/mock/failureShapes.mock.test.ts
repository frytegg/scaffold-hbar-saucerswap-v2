import { expect } from "chai";
import { ethers } from "hardhat";

import { ONE_HBAR, ROUTER, SAUCE, WHBAR, injectHederaMocks, quoted } from "./hederaMocks";
import type { MockSwapRouter } from "../../typechain-types";

/**
 * The failure shapes a swap comes back with on Hedera testnet, reproduced offline so that the decoder and the UI
 * are written against them. Each name says which shape and where it was measured; `docs/hedera-behaviour.md` links
 * the transactions.
 */

const DEADLINE = 2n ** 40n;
const INSUFFICIENT_TOKEN_BALANCE = 178n;
const TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 184n;

function exactInputParams(recipient: string, amountIn: bigint, amountOutMinimum: bigint) {
  return {
    path: ethers.solidityPacked(["address", "uint24", "address"], [WHBAR, 3000, SAUCE]),
    recipient,
    deadline: DEADLINE,
    amountIn,
    amountOutMinimum,
  };
}

/** The revert data of a call that was expected to fail, so that a test can read the shape and not only the name. */
async function revertDataOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error: unknown) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === "string") return data;
    throw error;
  }
  throw new Error("the call was expected to revert and did not");
}

describe("the failure shapes a SaucerSwap V2 swap comes back with", function () {
  let router: MockSwapRouter;
  let stranger: string;

  beforeEach(async function () {
    ({ router } = await injectHederaMocks());
    [, { address: stranger }] = await ethers.getSigners();
  });

  it("TransferFail(184) when the recipient has never held the token: the direct call keeps the reason", async function () {
    await expect(router.exactInput.staticCall(exactInputParams(stranger, ONE_HBAR, 0n), { value: ONE_HBAR }))
      .to.be.revertedWithCustomError(router, "TransferFail")
      .withArgs(TOKEN_NOT_ASSOCIATED_TO_ACCOUNT);
  });

  it("the same failure through multicall comes back with no data at all", async function () {
    const inner = router.interface.encodeFunctionData("exactInput", [exactInputParams(stranger, ONE_HBAR, 0n)]);

    // 36 bytes of custom error are shorter than the 68 the router's multicall requires to re-throw a reason.
    expect(await revertDataOf(router.multicall.staticCall([inner], { value: ONE_HBAR }))).to.equal("0x");
  });

  it("a revert of 68 bytes or more survives multicall: Too little received still says so", async function () {
    const impossible = quoted(ONE_HBAR) + 1n;
    const inner = router.interface.encodeFunctionData("exactInput", [exactInputParams(ROUTER, ONE_HBAR, impossible)]);

    await expect(router.multicall.staticCall([inner], { value: ONE_HBAR })).to.be.revertedWith("Too little received");
  });

  it("RespCode(178) when the router is paid nothing for the amount it is asked to swap", async function () {
    // What an unscaled value produces: the amount is in the calldata, but no HBAR came with the call, so the router
    // falls back to pulling WHBAR from a payer that holds none and the token service answers 178.
    await expect(router.exactInput.staticCall(exactInputParams(ROUTER, ONE_HBAR, 0n), { value: 0n }))
      .to.be.revertedWithCustomError(router, "RespCode")
      .withArgs(INSUFFICIENT_TOKEN_BALANCE);
  });
});
