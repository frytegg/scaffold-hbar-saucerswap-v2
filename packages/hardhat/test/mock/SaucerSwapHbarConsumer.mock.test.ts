import { expect } from "chai";
import { ethers, network } from "hardhat";

import {
  HTS,
  ONE_HBAR,
  POOL_FEE,
  ROUTER,
  SAUCE,
  WHBAR,
  deployConsumer,
  injectHederaMocks,
  quoted,
} from "./hederaMocks";

const AMOUNT_IN = ONE_HBAR;
/** Sent with the call so that the swap has room for the price moving; the router gives the rest back. */
const MARGIN = ONE_HBAR / 5n;
const MINIMUM_OUT = quoted(AMOUNT_IN) - 1_000_000n;
const DEADLINE = 2n ** 40n;
/** What `associateToken` returns when the token service answered nothing a response code can be read from. */
const NO_RESPONSE_CODE = -(2n ** 63n);
const TOKEN_ALREADY_ASSOCIATED = 194n;
const SUCCESS = 22n;

describe("SaucerSwapHbarConsumer against the mock token service and router", function () {
  it("puts the token service at 0x167 with empty storage: hardhat_setCode copies runtime code only", async function () {
    const { hts } = await injectHederaMocks();
    const [signer] = await ethers.getSigners();

    expect(await ethers.provider.getCode(HTS)).to.have.length.greaterThan(2);
    expect(await hts.isAssociated(SAUCE, signer.address)).to.equal(false);
  });

  describe("the constructor's association", function () {
    it("associates the contract with the output token, and the service answers 22", async function () {
      const { hts } = await injectHederaMocks();
      const { consumer, factory } = await deployConsumer();

      await expect(consumer.deploymentTransaction())
        .to.emit(factory.attach(await consumer.getAddress()), "Associated")
        .withArgs(SAUCE, SUCCESS);
      expect(await hts.isAssociated(SAUCE, await consumer.getAddress())).to.equal(true);
      expect(await consumer.tokenOut()).to.equal(SAUCE);
      expect(await consumer.poolFee()).to.equal(POOL_FEE);
    });

    it("refuses to exist when the token service answers no response code at all", async function () {
      await injectHederaMocks();
      // An address with no code answers every call with success and no data: the shape a contract that reads the
      // return value has to refuse, because reading it as a success would deploy a contract that cannot be paid.
      await network.provider.request({ method: "hardhat_setCode", params: [HTS, "0x"] });

      const factory = await ethers.getContractFactory("SaucerSwapHbarConsumer");
      await expect(factory.deploy(ROUTER, WHBAR, SAUCE, POOL_FEE))
        .to.be.revertedWithCustomError(factory, "AssociationFailed")
        .withArgs(NO_RESPONSE_CODE);
    });

    it("answers 194 on a second association: a successful call that changed nothing", async function () {
      await injectHederaMocks();
      const { consumer } = await deployConsumer();

      expect(await consumer.associate.staticCall()).to.equal(TOKEN_ALREADY_ASSOCIATED);
      await expect(consumer.associate()).to.emit(consumer, "Associated").withArgs(SAUCE, TOKEN_ALREADY_ASSOCIATED);
    });

    it("lets nobody but the deployer associate again", async function () {
      await injectHederaMocks();
      const { consumer } = await deployConsumer();
      const [, stranger] = await ethers.getSigners();

      await expect(consumer.connect(stranger).associate())
        .to.be.revertedWithCustomError(consumer, "NotOwner")
        .withArgs(stranger.address);
    });
  });

  describe("swapExactHbarForToken", function () {
    it("swaps the amount it was told to, keeps the tokens and returns the rest of the value", async function () {
      const { hts } = await injectHederaMocks();
      const { consumer } = await deployConsumer();
      const [caller] = await ethers.getSigners();

      const swap = consumer.swapExactHbarForToken(AMOUNT_IN, MINIMUM_OUT, DEADLINE, { value: AMOUNT_IN + MARGIN });
      await expect(swap).to.emit(consumer, "Swapped").withArgs(caller.address, AMOUNT_IN, quoted(AMOUNT_IN), MARGIN);
      // The margin came back in the same call, so the caller paid exactly what it asked to swap (fees aside).
      await expect(swap).to.changeEtherBalance(caller, -AMOUNT_IN);

      const address = await consumer.getAddress();
      expect(await consumer.tokenBalance()).to.equal(quoted(AMOUNT_IN));
      expect(await hts.balanceOf(SAUCE, address)).to.equal(quoted(AMOUNT_IN));
      expect(await ethers.provider.getBalance(address)).to.equal(0n);
      expect(await ethers.provider.getBalance(ROUTER)).to.equal(0n);
    });

    it("refuses a minimum output of zero, which would accept any price", async function () {
      await injectHederaMocks();
      const { consumer } = await deployConsumer();

      await expect(
        consumer.swapExactHbarForToken(AMOUNT_IN, 0n, DEADLINE, { value: AMOUNT_IN }),
      ).to.be.revertedWithCustomError(consumer, "MinimumOutIsZero");
    });

    it("refuses a value below the amount to swap, naming both in tinybar", async function () {
      await injectHederaMocks();
      const { consumer } = await deployConsumer();

      await expect(consumer.swapExactHbarForToken(AMOUNT_IN, MINIMUM_OUT, DEADLINE, { value: AMOUNT_IN - 1n }))
        .to.be.revertedWithCustomError(consumer, "ValueBelowAmountIn")
        .withArgs(AMOUNT_IN - 1n, AMOUNT_IN);
    });

    it("refuses a router that calls back into the swap while it holds the HBAR", async function () {
      const { router } = await injectHederaMocks();
      const { consumer } = await deployConsumer();
      const reentry = consumer.interface.encodeFunctionData("swapExactHbarForToken", [
        AMOUNT_IN,
        MINIMUM_OUT,
        DEADLINE,
      ]);
      await (await router.mockCallOnRefund(await consumer.getAddress(), reentry)).wait();

      await expect(
        consumer.swapExactHbarForToken(AMOUNT_IN, MINIMUM_OUT, DEADLINE, { value: AMOUNT_IN }),
      ).to.be.revertedWithCustomError(consumer, "RouterReentered");
    });
  });

  describe("withdrawals", function () {
    it("sends the tokens the contract bought to the owner", async function () {
      const { hts } = await injectHederaMocks();
      const { consumer } = await deployConsumer();
      const [owner] = await ethers.getSigners();
      await (await hts.mockCredit(SAUCE, owner.address, 0n)).wait();
      await (await consumer.swapExactHbarForToken(AMOUNT_IN, MINIMUM_OUT, DEADLINE, { value: AMOUNT_IN })).wait();

      await (await consumer.withdrawToken(owner.address, quoted(AMOUNT_IN))).wait();

      expect(await consumer.tokenBalance()).to.equal(0n);
      expect(await hts.balanceOf(SAUCE, owner.address)).to.equal(quoted(AMOUNT_IN));
    });

    it("reports a refused token transfer instead of recording a successful withdrawal", async function () {
      await injectHederaMocks();
      const { consumer } = await deployConsumer();
      const [, stranger] = await ethers.getSigners();
      await (await consumer.swapExactHbarForToken(AMOUNT_IN, MINIMUM_OUT, DEADLINE, { value: AMOUNT_IN })).wait();

      // The facade answers false because the token service refuses an account that never held SAUCE (code 184).
      await expect(consumer.withdrawToken(stranger.address, quoted(AMOUNT_IN)))
        .to.be.revertedWithCustomError(consumer, "TokenTransferFailed")
        .withArgs(stranger.address, quoted(AMOUNT_IN));
    });

    it("lets nobody but the deployer take the HBAR the contract holds", async function () {
      await injectHederaMocks();
      const { consumer } = await deployConsumer();
      const [, stranger] = await ethers.getSigners();

      await expect(consumer.connect(stranger).withdrawHbar(stranger.address, 1n))
        .to.be.revertedWithCustomError(consumer, "NotOwner")
        .withArgs(stranger.address);
    });
  });
});
