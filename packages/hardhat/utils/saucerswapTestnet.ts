/**
 * SaucerSwap V2 on Hedera testnet, in the only form a Hardhat deploy script needs: plain EVM addresses.
 *
 * `packages/nextjs/lib/hedera/addresses.ts` is this project's address book and the source of truth: it carries the
 * entity id, the source page and the date each entry was last read from the mirror node, and the `check:live`
 * script re-reads all of it. A Hardhat workspace cannot import a module of the Next.js workspace, so the four
 * entries a deployment needs are copied here. Change them in both files, or not at all.
 *
 * Source: https://docs.saucerswap.finance/developers/contracts#hedera-testnet
 */
export const saucerswapTestnet = {
  /** SwapRouter, 0.0.1414040. */
  swapRouter: "0x0000000000000000000000000000000000159398",
  /** The WHBAR token, 0.0.15058: what a swap path names for HBAR, not the contract that holds the wrapped HBAR. */
  whbar: "0x0000000000000000000000000000000000003aD2",
  /** The contract that holds the wrapped HBAR, 0.0.15057: what pays native HBAR out when the router unwraps. */
  whbarContract: "0x0000000000000000000000000000000000003aD1",
  /** SAUCE, 0.0.1183558, six decimals. */
  sauce: "0x0000000000000000000000000000000000120f46",
  /** NonfungiblePositionManager, 0.0.1308184: only the mock tier calls it, never a deployment. */
  positionManager: "0x000000000000000000000000000000000013F618",
  /** The HTS token that holds the positions, 0.0.1310436, where their approvals live. */
  lpNft: "0x000000000000000000000000000000000013feE4",
  /** The HBAR/SAUCE pool 0.0.2661057, which only the mock tier calls. */
  hbarSaucePool: "0x37814eDc1ae88cf27c0C346648721FB04e7E0AE7",
  /** That pool takes 0.30 %, written as hundredths of a basis point. */
  poolFee: 3000,
} as const;
