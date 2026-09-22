/**
 * SaucerSwap V2 on Hedera testnet, in the only form a Hardhat deploy script needs: plain EVM addresses.
 *
 * `packages/nextjs/lib/hedera/addresses.ts` is this project's address book and the source of truth: it carries the
 * entity id, the source page and the date each entry was last read from the mirror node, and `yarn check:live`
 * re-reads all of it. A Hardhat workspace cannot import a module of the Next.js workspace, so the four entries a
 * deployment needs are copied here. Change them in both files, or not at all.
 *
 * Source: https://docs.saucerswap.finance/developers/contracts#hedera-testnet
 */
export const saucerswapTestnet = {
  /** SwapRouter, 0.0.1414040. */
  swapRouter: "0x0000000000000000000000000000000000159398",
  /** The WHBAR token, 0.0.15058: what a swap path names for HBAR, not the contract that holds the wrapped HBAR. */
  whbar: "0x0000000000000000000000000000000000003aD2",
  /** SAUCE, 0.0.1183558, six decimals. */
  sauce: "0x0000000000000000000000000000000000120f46",
  /** The HBAR/SAUCE pool 0.0.2661057 takes 0.30 %, written as hundredths of a basis point. */
  poolFee: 3000,
} as const;
