import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import { getDeployGasPrice } from "../utils/getDeployGasPrice";
import { saucerswapTestnet } from "../utils/saucerswapTestnet";

/**
 * Deploys the SaucerSwap V2 consumer, on Hedera testnet only.
 *
 * Its constructor associates the contract with SAUCE through the token service at 0x167, and the addresses it takes
 * are SaucerSwap's testnet deployment: neither exists on a local network or on a fork, where the constructor would
 * get no response code at all and refuse to deploy. The mock tier covers the contract everywhere else
 * (the `test:mock` script), and the deployed contract is exercised on testnet by `evidence:consumer`.
 */
const deploySaucerSwapHbarConsumer: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (hre.network.name !== "hederaTestnet") {
    console.log(
      `Skipping SaucerSwapHbarConsumer on ${hre.network.name}: it needs the Hedera token service at 0x167 and ` +
        "SaucerSwap's testnet router. Run the `test:mock` script to exercise it offline.",
    );
    return;
  }

  const { deployer } = await hre.getNamedAccounts();
  const { swapRouter, whbar, sauce, poolFee } = saucerswapTestnet;

  await hre.deployments.deploy("SaucerSwapHbarConsumer", {
    from: deployer,
    args: [swapRouter, whbar, sauce, poolFee],
    log: true,
    autoMine: true,
    // hardhat-deploy sends legacy transactions on Hedera; the network charges the gas used, not this limit.
    gasLimit: "3000000",
    gasPrice: await getDeployGasPrice(hre),
  });
};

deploySaucerSwapHbarConsumer.tags = ["SaucerSwapHbarConsumer"];
export default deploySaucerSwapHbarConsumer;
