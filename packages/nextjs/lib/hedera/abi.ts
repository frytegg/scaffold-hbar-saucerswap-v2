import { parseAbi } from "viem";

// Written from the function shapes of the deployed testnet contracts, not copied from SaucerSwap's sources or ABI
// files (GPL-2.0 / BUSL-1.1): only the functions and errors this library calls or decodes.

/**
 * The custom errors SaucerSwap V2 raises on the swap path instead of letting a failed HTS call revert: the router's
 * `RespCode` when it pulls the input token, the pool's `TransferFail` when it pays the output out. Each carries a
 * Hedera response code. `multicall` drops both (they are shorter than 68 bytes) and reverts with empty data.
 */
const swapErrorSignatures = ["error RespCode(int32 responseCode)", "error TransferFail(int256 responseCode)"] as const;

/** Everything a revert on the swap path can carry: those two errors, or a revert string such as "Too little received". */
export const swapRevertAbi = parseAbi([...swapErrorSignatures, "error Error(string reason)"]);

export const swapRouterAbi = parseAbi([
  "struct ExactInputParams { bytes path; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; }",
  "function exactInput(ExactInputParams params) payable returns (uint256 amountOut)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function refundETH() payable",
  "function unwrapWHBAR(uint256 amountMinimum, address recipient) payable",
  "function factory() view returns (address)",
  // Two getters: whbar() is the token that paths name, WHBAR() the contract that wraps and unwraps it.
  "function whbar() view returns (address)",
  "function WHBAR() view returns (address)",
  ...swapErrorSignatures,
]);

export const quoterV2Abi = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

export const v2FactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);

/** The ERC-20 functions an HTS token answers at its own address. */
export const htsTokenAbi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
