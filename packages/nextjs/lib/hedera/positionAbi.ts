import { parseAbi } from "viem";

// Written from the function shapes of the deployed testnet contracts, not copied from SaucerSwap's or Uniswap's
// sources or ABI files (GPL-2.0-or-later and BUSL-1.1): only what this library calls or decodes. Two of these
// shapes differ from the Uniswap ABI that carries the same selector, and a UI built on the wrong one throws while
// decoding a call that succeeded:
//  - `positions` returns ten fields here, not twelve: the nonce and the operator of Uniswap's position are gone.
//  - `unwrapWHBAR` replaces `unwrapWETH9`, and the position manager holds the wrapped HBAR until it is called.
// `__tests__/positionBuilders.test.ts` rebuilds the calldata of four transactions this project sent, so a wrong
// field order or a wrong name fails there rather than on chain.

/** What the position manager raises when a Hedera service refuses underneath it; `multicall` erases all four. */
const positionErrorSignatures = [
  "error HederaFail(int256 responseCode)",
  "error TransferFail(int256 responseCode)",
  "error RespCode(int32 responseCode)",
  "error MF()",
  "error CF()",
] as const;

/** Everything a revert on the position path can carry, for the decoder. */
export const positionRevertAbi = parseAbi([...positionErrorSignatures, "error Error(string reason)"]);

export const positionManagerAbi = parseAbi([
  "struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }",
  "struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }",
  "struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }",
  "function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity(DecreaseLiquidityParams params) payable returns (uint256 amount0, uint256 amount1)",
  "function collect(CollectParams params) payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function refundETH() payable",
  "function unwrapWHBAR(uint256 amountMinimum, address recipient) payable",
  "function positions(uint256 tokenId) view returns (address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  ...positionErrorSignatures,
]);

/** The ERC-721 functions the HTS facade of the position NFT answers. It has no enumeration: the mirror node has. */
export const lpNftAbi = parseAbi([
  "function ownerOf(uint256 serial) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
]);

export const v2PoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);

/** The V2 factory's fee for opening a position, in tinycent. The position manager itself does not answer it. */
export const v2FactoryFeeAbi = parseAbi(["function mintFee() view returns (uint256)"]);

/** The exchange-rate system contract: the only rate the network itself charges at. */
export const exchangeRateAbi = parseAbi(["function tinycentsToTinybars(uint256 tinycents) returns (uint256)"]);
