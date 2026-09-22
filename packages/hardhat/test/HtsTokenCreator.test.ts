import { expect } from "chai";
import { ethers } from "hardhat";
import type { HtsTokenCreator } from "../typechain-types";

describe("HtsTokenCreator", function () {
  async function deployFixture() {
    const [owner, alice] = await ethers.getSigners();
    const HtsTokenCreator = await ethers.getContractFactory("HtsTokenCreator");
    const creator = await HtsTokenCreator.deploy();
    await creator.waitForDeployment();
    return { creator, owner, alice };
  }

  // HTS supplies are int64 (max 2^63-1): with 6 decimals, 10,000 tokens are 1e10 units.
  const DECIMALS = 6;
  const parseHtsUnits = (amount: string) => ethers.parseUnits(amount, DECIMALS);
  // 1 HBAR as a transaction value (18 decimals). The fork's emulated token service only requires a non-zero value.
  const HTS_CREATE_VALUE = ethers.parseUnits("1", 18);

  /** Creates a token through `creator` and returns it as an ERC-20, once the creation event has named it. */
  async function createToken(creator: HtsTokenCreator, name: string, symbol: string, initialSupply: bigint) {
    const tokenAddress = await creator.createToken.staticCall(name, symbol, initialSupply, DECIMALS, {
      value: HTS_CREATE_VALUE,
    });
    await expect(creator.createToken(name, symbol, initialSupply, DECIMALS, { value: HTS_CREATE_VALUE }))
      .to.emit(creator, "TokenCreated")
      .withArgs(tokenAddress, name, symbol);
    return ethers.getContractAt("IERC20Metadata", tokenAddress);
  }

  describe("createToken", function () {
    it("creates a fungible token with the requested name, symbol and decimals", async function () {
      const { creator } = await deployFixture();
      const token = await createToken(creator, "Test HTS Token", "THT", parseHtsUnits("10000"));

      expect(await token.name()).to.equal("Test HTS Token");
      expect(await token.symbol()).to.equal("THT");
      expect(await token.decimals()).to.equal(DECIMALS);
    });

    it("makes the caller the treasury, holding the whole initial supply", async function () {
      const { creator, alice } = await deployFixture();
      const initialSupply = parseHtsUnits("1000");
      const token = await createToken(creator.connect(alice), "Treasury Token", "TRS", initialSupply);

      expect(await token.totalSupply()).to.equal(initialSupply);
      expect(await token.balanceOf(alice.address)).to.equal(initialSupply);
    });
  });

  describe("mintToken", function () {
    it("adds the minted amount to the total supply and to the treasury", async function () {
      const { creator, owner } = await deployFixture();
      const initialSupply = parseHtsUnits("1000");
      const mintAmount = parseHtsUnits("500");
      const token = await createToken(creator, "Mintable Token", "MNT", initialSupply);
      const tokenAddress = await token.getAddress();

      await expect(creator.mintToken(tokenAddress, mintAmount))
        .to.emit(creator, "TokenMinted")
        .withArgs(tokenAddress, initialSupply + mintAmount);
      expect(await token.totalSupply()).to.equal(initialSupply + mintAmount);
      expect(await token.balanceOf(owner.address)).to.equal(initialSupply + mintAmount);
    });
  });
});
