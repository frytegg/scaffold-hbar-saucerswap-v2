import hre, { ethers, network } from "hardhat";

import { saucerswapTestnet } from "../../utils/saucerswapTestnet";
import type { MockHederaTokenService, MockHtsToken, MockSwapRouter } from "../../typechain-types";

/**
 * The mock tier's setup: three original mocks put at the addresses the real ones have on Hedera testnet, with
 * `hardhat_setCode`, on the plain in-process network. No fork, no plugin, no network call.
 *
 * Putting them at the real addresses is the point: the contract under test is built with the same address book a
 * deployment uses, so nothing about it is test-only. `hardhat_setCode` copies runtime code and leaves storage
 * empty, which is why the mocks take their state from `mockCredit` and `mockConfigure` rather than a constructor,
 * and why every test starts from a reset network.
 */

/** The Hedera token service's address: a system contract, so the same number on every Hedera network. */
export const HTS = "0x0000000000000000000000000000000000000167";

export const { swapRouter: ROUTER, whbar: WHBAR, sauce: SAUCE, poolFee: POOL_FEE } = saucerswapTestnet;

/** One HBAR in tinybar. Inside the EVM, Hedera amounts have eight decimals; the relay divides the signed weibar. */
export const ONE_HBAR = 100_000_000n;

/** SAUCE units per tinybar, scaled by 1e6: about 46.48 SAUCE for one HBAR, the testnet quote of 21 Sept 2026. */
export const SAUCE_PER_TINYBAR_E6 = 464_827n;

export const quoted = (amountInTinybar: bigint): bigint => (amountInTinybar * SAUCE_PER_TINYBAR_E6) / 1_000_000n;

async function putCodeAt(address: string, contractName: string): Promise<void> {
  const { deployedBytecode } = await hre.artifacts.readArtifact(contractName);
  await network.provider.request({ method: "hardhat_setCode", params: [address, deployedBytecode] });
}

export type HederaMocks = { hts: MockHederaTokenService; router: MockSwapRouter; sauce: MockHtsToken };

/**
 * Resets the network, then injects the token service, the SAUCE facade and the router. The router is left with the
 * SAUCE it needs to pay a swap out; nothing else is associated and nothing else holds a balance.
 */
export async function injectHederaMocks(routerInventory = 1_000_000_000_000n): Promise<HederaMocks> {
  await network.provider.request({ method: "hardhat_reset", params: [] });
  await putCodeAt(HTS, "MockHederaTokenService");
  await putCodeAt(SAUCE, "MockHtsToken");
  await putCodeAt(ROUTER, "MockSwapRouter");

  const hts = await ethers.getContractAt("MockHederaTokenService", HTS);
  const router = await ethers.getContractAt("MockSwapRouter", ROUTER);
  const sauce = await ethers.getContractAt("MockHtsToken", SAUCE);
  await (await router.mockConfigure(SAUCE, SAUCE_PER_TINYBAR_E6)).wait();
  await (await hts.mockCredit(SAUCE, ROUTER, routerInventory)).wait();
  return { hts, router, sauce };
}

/** Deploys the consumer against the injected mocks, exactly as the testnet deploy script builds it. */
export async function deployConsumer() {
  const factory = await ethers.getContractFactory("SaucerSwapHbarConsumer");
  const consumer = await factory.deploy(ROUTER, WHBAR, SAUCE, POOL_FEE);
  await consumer.waitForDeployment();
  return { consumer, factory };
}
