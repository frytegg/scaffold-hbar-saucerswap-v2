import { expect } from "chai";
import { ethers } from "hardhat";

import { saucerswapTestnet } from "../../utils/saucerswapTestnet";
import { FIRST_SERIAL, MANAGER, MINT_FEE_TINYBAR, ONE_HBAR, SAUCE, WHBAR, injectPositionMocks } from "./positionMocks";
import type { MockHederaTokenService, MockHtsToken, MockLpNft, MockPositionManager } from "../../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * The position life cycle, and the three ways it fails on Hedera, offline. Each name states the rule it enforces;
 * `packages/nextjs/lib/hedera/__tests__/fixtures/position/` holds the transactions the shapes were measured on.
 */

const DEADLINE = 2n ** 40n;
const UINT128_MAX = 2n ** 128n - 1n;
const HBAR_LEG = ONE_HBAR / 4n;
const SAUCE_LEG = 20_000_000n;
const TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 184n;
const SPENDER_DOES_NOT_HAVE_ALLOWANCE = 292n;

const mintParams = (recipient: string, overrides: { amount0Min?: bigint; amount1Min?: bigint } = {}) => ({
  token0: WHBAR,
  token1: SAUCE,
  fee: saucerswapTestnet.poolFee,
  tickLower: -7680,
  tickUpper: -7620,
  amount0Desired: HBAR_LEG,
  amount1Desired: SAUCE_LEG,
  amount0Min: overrides.amount0Min ?? 1n,
  amount1Min: overrides.amount1Min ?? 1n,
  recipient,
  deadline: DEADLINE,
});

/** The revert data of a call that was expected to fail, so a test can read the shape and not only the name. */
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

describe("a SaucerSwap V2 position, opened and closed", function () {
  let hts: MockHederaTokenService;
  let manager: MockPositionManager;
  let lpNft: MockLpNft;
  let sauce: MockHtsToken;
  let holder: HardhatEthersSigner;

  /** The value a mint carries: the HBAR the position deposits, the mint fee, and a margin refundETH returns. */
  const value = HBAR_LEG + MINT_FEE_TINYBAR + ONE_HBAR / 100n;

  beforeEach(async function () {
    ({ hts, manager, lpNft, sauce } = await injectPositionMocks());
    [, holder] = await ethers.getSigners();
    await (await hts.mockCredit(SAUCE, holder.address, SAUCE_LEG * 10n)).wait();
    // The manager pulls the pool's token out of the holder's account, so it needs the holder's allowance first —
    // granted to the manager, not to the router, and on the token's own facade.
    await (await sauce.connect(holder).approve(MANAGER, SAUCE_LEG)).wait();
  });

  const mint = async (overrides: Parameters<typeof mintParams>[1] = {}) => {
    const call = manager.interface.encodeFunctionData("mint", [mintParams(holder.address, overrides)]);
    const refund = manager.interface.encodeFunctionData("refundETH");
    return manager.connect(holder).multicall([call, refund], { value });
  };

  it("mints a position the holder owns, and returns the value the mint did not need", async function () {
    const before = await ethers.provider.getBalance(holder.address);
    const receipt = await (await mint()).wait();
    if (receipt === null) throw new Error("the mint was mined");

    expect(await lpNft.ownerOf(FIRST_SERIAL)).to.equal(holder.address);
    const spent = before - (await ethers.provider.getBalance(holder.address));
    // refundETH swept the margin back, so only the deposit and the fee left the account, plus the gas.
    expect(spent - receipt.gasUsed * receipt.gasPrice).to.equal(HBAR_LEG + MINT_FEE_TINYBAR);
  });

  it("answers ten fields from positions(), where a Uniswap ABI of the same selector expects twelve", async function () {
    await (await mint()).wait();
    const uniswap = new ethers.Interface([
      "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint128,uint128,uint128,uint128)",
    ]);
    const answer = await ethers.provider.call({
      to: MANAGER,
      data: uniswap.encodeFunctionData("positions", [FIRST_SERIAL]),
    });

    expect(() => uniswap.decodeFunctionResult("positions", answer)).to.throw();
    const position = await manager.positions(FIRST_SERIAL);
    expect(position.length).to.equal(10);
    expect(position[0]).to.equal(WHBAR);
    expect(position[1]).to.equal(SAUCE);
    expect(position[5]).to.equal(SAUCE_LEG);
  });

  it("refuses a mint whose value cannot pay the mint fee, with the periphery's own MF", async function () {
    const call = manager.interface.encodeFunctionData("mint", [mintParams(holder.address)]);
    await expect(
      manager.connect(holder).mint(mintParams(holder.address), { value: HBAR_LEG }),
    ).to.be.revertedWithCustomError(manager, "MF");
    // MF() is four bytes, so the same refusal loses its name inside a multicall.
    expect(await revertDataOf(manager.connect(holder).multicall([call], { value: HBAR_LEG }))).to.equal("0x");
  });

  it("refuses a mint that would deposit less than the minimums it names", async function () {
    await expect(mint({ amount1Min: SAUCE_LEG + 1n })).to.be.revertedWith("Price slippage check");
  });

  it("reverts RespCode(292) when the manager holds no allowance on the pool's token", async function () {
    await (await sauce.connect(holder).approve(MANAGER, 0n)).wait();

    await expect(manager.connect(holder).mint.staticCall(mintParams(holder.address), { value }))
      .to.be.revertedWithCustomError(manager, "RespCode")
      .withArgs(SPENDER_DOES_NOT_HAVE_ALLOWANCE);
    expect(await sauce.allowance(holder.address, MANAGER)).to.equal(0n);
  });

  it("spends the allowance it was given, and no more", async function () {
    await (await mint()).wait();

    expect(await sauce.allowance(holder.address, MANAGER)).to.equal(0n);
  });

  it("delivers native HBAR and the token when the collect is split in three", async function () {
    await (await mint()).wait();
    const position = await manager.positions(FIRST_SERIAL);
    await (
      await manager.connect(holder).decreaseLiquidity({
        tokenId: FIRST_SERIAL,
        liquidity: position[5],
        amount0Min: 1n,
        amount1Min: 1n,
        deadline: DEADLINE,
      })
    ).wait();

    const toManager = manager.interface.encodeFunctionData("collect", [
      { tokenId: FIRST_SERIAL, recipient: ethers.ZeroAddress, amount0Max: UINT128_MAX, amount1Max: 0n },
    ]);
    const unwrap = manager.interface.encodeFunctionData("unwrapWHBAR", [0n, holder.address]);
    const toHolder = manager.interface.encodeFunctionData("collect", [
      { tokenId: FIRST_SERIAL, recipient: holder.address, amount0Max: 0n, amount1Max: UINT128_MAX },
    ]);

    const before = await ethers.provider.getBalance(holder.address);
    const receipt = await (await manager.connect(holder).multicall([toManager, unwrap, toHolder])).wait();
    if (receipt === null) throw new Error("the collect was mined");

    const received = (await ethers.provider.getBalance(holder.address)) - before + receipt.gasUsed * receipt.gasPrice;
    expect(received).to.equal(HBAR_LEG);
    expect(await hts.balanceOf(SAUCE, holder.address)).to.equal(SAUCE_LEG * 9n + SAUCE_LEG);
    // Nothing wrapped is left behind: the holder has HBAR, not a token it would have to unwrap itself.
    expect(await hts.balanceOf(WHBAR, MANAGER)).to.equal(0n);
    expect(await hts.balanceOf(WHBAR, holder.address)).to.equal(0n);
  });

  it("refuses the unwrap when the manager holds less wrapped HBAR than the floor the collect names", async function () {
    await (await mint()).wait();
    const position = await manager.positions(FIRST_SERIAL);
    await (
      await manager.connect(holder).decreaseLiquidity({
        tokenId: FIRST_SERIAL,
        liquidity: position[5],
        amount0Min: 1n,
        amount1Min: 1n,
        deadline: DEADLINE,
      })
    ).wait();

    // The unwrap is a sweep of whatever the manager holds, so a floor is the only thing that tells a collect which
    // paid out from one which pulled nothing: here the wrapped HBAR is never collected in, and the floor catches it.
    const unwrap = manager.interface.encodeFunctionData("unwrapWHBAR", [HBAR_LEG, holder.address]);
    const toHolder = manager.interface.encodeFunctionData("collect", [
      { tokenId: FIRST_SERIAL, recipient: holder.address, amount0Max: 0n, amount1Max: UINT128_MAX },
    ]);
    await expect(manager.connect(holder).multicall([unwrap, toHolder])).to.be.revertedWith("Insufficient WHBAR");

    // The control: the same two calls with no floor succeed, having moved no HBAR at all.
    const before = await ethers.provider.getBalance(holder.address);
    const noFloor = manager.interface.encodeFunctionData("unwrapWHBAR", [0n, holder.address]);
    const receipt = await (await manager.connect(holder).multicall([noFloor, toHolder])).wait();
    if (receipt === null) throw new Error("the collect was mined");
    const received = (await ethers.provider.getBalance(holder.address)) - before + receipt.gasUsed * receipt.gasPrice;
    expect(received).to.equal(0n);
  });

  it("reverts TransferFail(184) when a collect sends both sides to the manager, as the Uniswap pattern does", async function () {
    await (await mint()).wait();
    const position = await manager.positions(FIRST_SERIAL);
    await (
      await manager.connect(holder).decreaseLiquidity({
        tokenId: FIRST_SERIAL,
        liquidity: position[5],
        amount0Min: 1n,
        amount1Min: 1n,
        deadline: DEADLINE,
      })
    ).wait();

    const bothToManager = {
      tokenId: FIRST_SERIAL,
      recipient: ethers.ZeroAddress,
      amount0Max: UINT128_MAX,
      amount1Max: UINT128_MAX,
    };
    await expect(manager.connect(holder).collect.staticCall(bothToManager))
      .to.be.revertedWithCustomError(manager, "TransferFail")
      .withArgs(TOKEN_NOT_ASSOCIATED_TO_ACCOUNT);
  });

  it("loses that reason entirely when the same collect is wrapped in a multicall", async function () {
    await (await mint()).wait();
    const position = await manager.positions(FIRST_SERIAL);
    await (
      await manager.connect(holder).decreaseLiquidity({
        tokenId: FIRST_SERIAL,
        liquidity: position[5],
        amount0Min: 1n,
        amount1Min: 1n,
        deadline: DEADLINE,
      })
    ).wait();
    const inner = manager.interface.encodeFunctionData("collect", [
      { tokenId: FIRST_SERIAL, recipient: ethers.ZeroAddress, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX },
    ]);

    // 36 bytes of custom error are shorter than the 68 a multicall needs to re-throw a reason.
    expect(await revertDataOf(manager.connect(holder).multicall.staticCall([inner]))).to.equal("0x");
  });

  it("reverts HederaFail(292) on a burn while the manager holds no approval on the position NFT", async function () {
    await (await mint()).wait();
    await emptyPosition();

    expect(await lpNft.isApprovedForAll(holder.address, MANAGER)).to.equal(false);
    await expect(manager.connect(holder).burn.staticCall(FIRST_SERIAL))
      .to.be.revertedWithCustomError(manager, "HederaFail")
      .withArgs(SPENDER_DOES_NOT_HAVE_ALLOWANCE);
  });

  it("burns the position once the manager is approved, and the serial is gone", async function () {
    await (await mint()).wait();
    await emptyPosition();
    await (await lpNft.connect(holder).setApprovalForAll(MANAGER, true)).wait();

    await (await manager.connect(holder).burn(FIRST_SERIAL)).wait();
    await expect(lpNft.ownerOf(FIRST_SERIAL)).to.be.revertedWith("Invalid token ID");
  });

  it("refuses to burn a position that still holds liquidity", async function () {
    await (await mint()).wait();
    await (await lpNft.connect(holder).setApprovalForAll(MANAGER, true)).wait();

    await expect(manager.connect(holder).burn.staticCall(FIRST_SERIAL)).to.be.revertedWith("Not cleared");
  });

  it("refuses every call of the life cycle from an account that does not own the position", async function () {
    await (await mint()).wait();
    const [stranger] = await ethers.getSigners();

    await expect(manager.connect(stranger).burn.staticCall(FIRST_SERIAL)).to.be.revertedWith("not authorized");
    await expect(
      manager.connect(stranger).collect.staticCall({
        tokenId: FIRST_SERIAL,
        recipient: stranger.address,
        amount0Max: UINT128_MAX,
        amount1Max: UINT128_MAX,
      }),
    ).to.be.revertedWith("not authorized");
  });

  /** Takes every unit of liquidity out and pays it to the holder, so that only the burn is left. */
  async function emptyPosition(): Promise<void> {
    const position = await manager.positions(FIRST_SERIAL);
    await (
      await manager.connect(holder).decreaseLiquidity({
        tokenId: FIRST_SERIAL,
        liquidity: position[5],
        amount0Min: 1n,
        amount1Min: 1n,
        deadline: DEADLINE,
      })
    ).wait();
    const toManager = manager.interface.encodeFunctionData("collect", [
      { tokenId: FIRST_SERIAL, recipient: ethers.ZeroAddress, amount0Max: UINT128_MAX, amount1Max: 0n },
    ]);
    const unwrap = manager.interface.encodeFunctionData("unwrapWHBAR", [0n, holder.address]);
    const toHolder = manager.interface.encodeFunctionData("collect", [
      { tokenId: FIRST_SERIAL, recipient: holder.address, amount0Max: 0n, amount1Max: UINT128_MAX },
    ]);
    await (await manager.connect(holder).multicall([toManager, unwrap, toHolder])).wait();
  }
});
