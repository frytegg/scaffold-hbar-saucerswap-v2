import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import hre, { ethers, network } from "hardhat";

import { saucerswapTestnet } from "../../utils/saucerswapTestnet";
import { HTS, ONE_HBAR, SAUCE, WHBAR, injectHederaMocks } from "./hederaMocks";
import type {
  MockHederaTokenService,
  MockHtsToken,
  MockLpNft,
  MockPositionManager,
  MockV2Pool,
  MockWhbarVault,
} from "../../typechain-types";

/**
 * The position tier of the mocks: the manager, the facade of the token that holds the positions, and the vault the
 * wrapped HBAR comes out of, each at the address it has on Hedera testnet.
 *
 * It builds on `injectHederaMocks`, so the token service and the SAUCE facade are the same ones the swap tests use:
 * a token still cannot reach an account that has never held it, which is what makes the failures below real. The
 * pool is the constant address the manager pays into and collects from; it is credited here, since this tier models
 * no curve and no price.
 */

export const {
  positionManager: MANAGER,
  lpNft: LP_NFT,
  whbarContract: WHBAR_VAULT,
  hbarSaucePool: POOL,
} = saucerswapTestnet;

/** The serial the next mint takes, one past the last this project minted on testnet. */
export const FIRST_SERIAL = 361n;

/**
 * The mint fee the network charged for a position on 21 and 22 Sept 2026: 500,000,000 tinycent through the exchange
 * rate contract, read back here from the answer that call was captured with rather than typed in.
 */
const MINT_FEE_FIXTURE = resolve(
  __dirname,
  "../../../nextjs/lib/hedera/__tests__/fixtures/rpc/call-tinycents-to-tinybars.json",
);
export const MINT_FEE_TINYBAR = BigInt(
  (JSON.parse(readFileSync(MINT_FEE_FIXTURE, "utf8")) as { body: { result: string } }).body.result,
);

async function putCodeAt(address: string, contractName: string): Promise<void> {
  const { deployedBytecode } = await hre.artifacts.readArtifact(contractName);
  await network.provider.request({ method: "hardhat_setCode", params: [address, deployedBytecode] });
}

export type PositionMocks = {
  hts: MockHederaTokenService;
  manager: MockPositionManager;
  lpNft: MockLpNft;
  vault: MockWhbarVault;
  pool: MockV2Pool;
  sauce: MockHtsToken;
};

/**
 * Resets the network and injects the whole tier. The pool holds both tokens, the manager is associated with the
 * wrapped HBAR and **not** with the pool's other token — which is the state that makes the Uniswap collect pattern
 * revert — and the vault holds the HBAR an unwrap pays out.
 */
export async function injectPositionMocks(): Promise<PositionMocks> {
  const { hts, sauce } = await injectHederaMocks();
  await putCodeAt(MANAGER, "MockPositionManager");
  await putCodeAt(LP_NFT, "MockLpNft");
  await putCodeAt(WHBAR_VAULT, "MockWhbarVault");
  await putCodeAt(WHBAR, "MockHtsToken");
  await putCodeAt(POOL, "MockV2Pool");

  const manager = await ethers.getContractAt("MockPositionManager", MANAGER);
  const lpNft = await ethers.getContractAt("MockLpNft", LP_NFT);
  const vault = await ethers.getContractAt("MockWhbarVault", WHBAR_VAULT);
  const pool = await ethers.getContractAt("MockV2Pool", POOL);

  await (await pool.mockConfigure(WHBAR, SAUCE)).wait();
  await (
    await manager.mockConfigure(
      POOL,
      LP_NFT,
      WHBAR_VAULT,
      WHBAR,
      SAUCE,
      saucerswapTestnet.poolFee,
      MINT_FEE_TINYBAR,
      FIRST_SERIAL,
    )
  ).wait();
  await (await hts.mockCredit(WHBAR, POOL, 1_000n * ONE_HBAR)).wait();
  await (await hts.mockCredit(SAUCE, POOL, 1_000_000_000n)).wait();
  // The manager holds the wrapped HBAR it collects, and nothing else: mockCredit is what associates an account.
  // It is never associated with the pool's other token, which is what makes the Uniswap collect pattern revert.
  await (await hts.mockCredit(WHBAR, MANAGER, 0n)).wait();
  await (await hts.mockCredit(WHBAR, WHBAR_VAULT, 0n)).wait();
  const [funder] = await ethers.getSigners();
  await (await funder.sendTransaction({ to: WHBAR_VAULT, value: 1_000n * ONE_HBAR })).wait();
  return { hts, manager, lpNft, vault, pool, sauce };
}

/** The address the token service is injected at, re-exported so a position test needs one import. */
export { HTS, ONE_HBAR, SAUCE, WHBAR };
