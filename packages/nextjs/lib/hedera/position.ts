import { htsTokenAbi } from "./abi";
import { type HbarPoolEntry, type TokenEntry, testnet } from "./addresses";
import type { EvmAddress } from "./evmAddress";
import { gasRuleFor, withGasLimit } from "./gasRules";
import { lpNftAbi, positionManagerAbi } from "./positionAbi";
import { type TickRange, assertRange, snapRangeToSpacing } from "./tickMath";
import { type Tinybar, type Weibar, payable, tinybar } from "./units";
import { type Hex, encodeFunctionData } from "viem";

// The four calls that open, shrink, empty and close a SaucerSwap V2 position, each in the shape Hedera accepts
// rather than the shape the Uniswap documentation gives. Every departure was paid for on testnet, and each one is
// stated on the builder it belongs to; `docs/hedera-behaviour.md` links the transactions that established them.

export type PositionBuildErrorCode =
  | "zero-minimum"
  | "amount-out-of-range"
  | "no-desired-amount"
  | "missing-nft-approval"
  | "invalid-margin"
  | "no-gas-rule";

export class PositionBuildError extends Error {
  readonly code: PositionBuildErrorCode;

  constructor(code: PositionBuildErrorCode, message: string) {
    super(message);
    this.name = "PositionBuildError";
    this.code = code;
  }
}

/** A call on the position manager, in the untyped form viem and wagmi accept for any ABI. */
export type PositionCall = {
  readonly address: EvmAddress;
  readonly abi: typeof positionManagerAbi;
  readonly functionName: string;
  readonly args: readonly unknown[];
  readonly value?: Weibar;
  readonly gas?: bigint;
};

/** An approval, on the token facade for the input token or on the NFT facade for the position itself. */
export type ApprovalCall = {
  readonly address: EvmAddress;
  readonly abi: typeof htsTokenAbi | typeof lpNftAbi;
  readonly functionName: "approve" | "setApprovalForAll";
  readonly args: readonly unknown[];
};

const MAX_HTS_AMOUNT = 2n ** 63n - 1n;
const MAX_UINT128 = 2n ** 128n - 1n;
const BASIS_POINTS = 10_000n;
const MAX_MARGIN_BPS = 5_000;

/**
 * The margin this template adds to the mint fee. The fee is quoted in tinycent and converted to HBAR again at
 * execution, so the figure read a moment earlier can be short by the time the network charges it; `refundETH`
 * returns whatever the margin was not needed for.
 */
export const MINT_FEE_MARGIN_BPS = 200;

function assertHtsAmount(amount: bigint, what: string): bigint {
  if (amount < 0n || amount > MAX_HTS_AMOUNT) {
    throw new PositionBuildError(
      "amount-out-of-range",
      `${what} must be between 0 and 2^63 - 1 (HTS amounts are int64), and is ${amount}.`,
    );
  }
  return amount;
}

/**
 * The minimum amounts a mint or a decrease accepts. Zero on both sides accepts any price the pool happens to be at
 * when the transaction reaches consensus, so it has to be asked for: `acceptAnyPrice` is how a script that owns the
 * risk says so out loud.
 */
export type Minimums = {
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
  readonly acceptAnyPrice?: boolean;
};

function assertMinimums(minimums: Minimums, what: string): Minimums {
  const { amount0Min, amount1Min, acceptAnyPrice = false } = minimums;
  assertHtsAmount(amount0Min, "amount0Min");
  assertHtsAmount(amount1Min, "amount1Min");
  if (!acceptAnyPrice && amount0Min === 0n && amount1Min === 0n) {
    throw new PositionBuildError(
      "zero-minimum",
      `This ${what} has no minimum on either side, so it accepts whatever price the pool is at when it reaches ` +
        "consensus. Pass amounts a slippage tolerance under what the range needs, or acceptAnyPrice: true.",
    );
  }
  return minimums;
}

/** The two tokens of an HBAR pool in the order the pool holds them, which is the order of their addresses. */
export function orderPoolTokens(pool: HbarPoolEntry): {
  readonly token0: TokenEntry;
  readonly token1: TokenEntry;
  readonly hbarIsToken0: boolean;
} {
  const hbarIsToken0 = BigInt(testnet.whbar.evmAddress) < BigInt(pool.token.evmAddress);
  return hbarIsToken0
    ? { token0: testnet.whbar, token1: pool.token, hbarIsToken0 }
    : { token0: pool.token, token1: testnet.whbar, hbarIsToken0 };
}

/**
 * What the transaction has to carry: the HBAR the position deposits, the mint fee, the margin above it, and the one
 * tinybar the periphery adds when it converts the fee again on chain.
 */
export function mintValue(request: {
  readonly hbarAmount: Tinybar;
  readonly mintFeeTinybar: Tinybar;
  readonly marginBps?: number;
}): Tinybar {
  const { hbarAmount, mintFeeTinybar, marginBps = MINT_FEE_MARGIN_BPS } = request;
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps > MAX_MARGIN_BPS) {
    throw new PositionBuildError(
      "invalid-margin",
      `A fee margin of ${marginBps} basis points is not an integer from 0 to ${MAX_MARGIN_BPS}.`,
    );
  }
  const feeWithMargin = (mintFeeTinybar * (BASIS_POINTS + BigInt(marginBps))) / BASIS_POINTS + 1n;
  return tinybar(hbarAmount + feeWithMargin);
}

/** The gas limit this template sends a mint with, and where the number comes from. */
export function positionMintGasLimit(): bigint {
  const rule = gasRuleFor(testnet.positionManager.evmAddress, ["mint"]);
  if (rule === null) {
    throw new PositionBuildError(
      "no-gas-rule",
      `No gas rule covers mint on ${testnet.positionManager.evmAddress}, and no simulator will price it.`,
    );
  }
  return rule.gasLimit;
}

export type PositionMintRequest = {
  readonly pool: HbarPoolEntry;
  /** The account the position NFT goes to: its own EVM address, never the long-zero form. */
  readonly recipient: EvmAddress;
  readonly range: TickRange;
  /** The pool's own spacing, as `tickSpacing()` answers: the range is widened to it. */
  readonly tickSpacing: number;
  readonly hbarAmount: Tinybar;
  readonly tokenAmount: bigint;
  readonly minimums: Minimums;
  /** Unix seconds after which the manager refuses the mint. */
  readonly deadline: bigint;
  /** The fee from the factory, already converted through the exchange-rate contract. */
  readonly mintFeeTinybar: Tinybar;
  readonly marginBps?: number;
  /** `positionMintGasLimit()`. Without it the call is refused: no wallet can price a mint. */
  readonly gas?: bigint;
};

/**
 * `multicall[mint, refundETH]`, with the value and the gas limit the network needs. It is the only call of this
 * module that cannot be simulated: `eth_call` and `eth_estimateGas` both answer INVALID_NFT_ID for a mint that the
 * network then executes, so the limit comes from `gasRules.ts` and the refusal below is what stops a caller from
 * handing a wallet a transaction it cannot price.
 */
export function buildPositionMint(request: PositionMintRequest): PositionCall {
  const { pool, recipient, tickSpacing, hbarAmount, tokenAmount, minimums, deadline } = request;
  assertHtsAmount(hbarAmount, "The HBAR amount");
  assertHtsAmount(tokenAmount, `The ${pool.token.symbol} amount`);
  if (hbarAmount === 0n && tokenAmount === 0n) {
    throw new PositionBuildError("no-desired-amount", "A mint has to offer an amount of at least one of the tokens.");
  }
  const { amount0Min, amount1Min } = assertMinimums(minimums, "mint");
  const { tickLower, tickUpper } = snapRangeToSpacing(assertRange(request.range), tickSpacing);
  const { token0, token1, hbarIsToken0 } = orderPoolTokens(pool);
  const mint = encodeFunctionData({
    abi: positionManagerAbi,
    functionName: "mint",
    args: [
      {
        token0: token0.evmAddress,
        token1: token1.evmAddress,
        fee: pool.fee,
        tickLower,
        tickUpper,
        amount0Desired: hbarIsToken0 ? hbarAmount : tokenAmount,
        amount1Desired: hbarIsToken0 ? tokenAmount : hbarAmount,
        amount0Min,
        amount1Min,
        recipient,
        deadline,
      },
    ],
  });
  const refundETH = encodeFunctionData({ abi: positionManagerAbi, functionName: "refundETH" });
  const call: PositionCall = {
    address: testnet.positionManager.evmAddress,
    abi: positionManagerAbi,
    functionName: "multicall",
    args: [[mint, refundETH]],
    ...payable(mintValue(request)),
  };
  return withGasLimit(call, { functions: ["mint", "refundETH"], gas: request.gas });
}

export type DecreaseLiquidityRequest = {
  readonly tokenId: bigint;
  readonly liquidity: bigint;
  readonly minimums: Minimums;
  readonly deadline: bigint;
};

/**
 * Takes liquidity out of a position and leaves the amounts owed to it inside the manager. It does not pay anything
 * out: `buildSplitCollect` is what moves the tokens, and the position keeps its NFT until it is burnt.
 */
export function buildDecreaseLiquidity(request: DecreaseLiquidityRequest): PositionCall {
  const { tokenId, liquidity, deadline } = request;
  const { amount0Min, amount1Min } = assertMinimums(request.minimums, "decrease");
  return {
    address: testnet.positionManager.evmAddress,
    abi: positionManagerAbi,
    functionName: "decreaseLiquidity",
    args: [{ tokenId, liquidity, amount0Min, amount1Min, deadline }],
  };
}

function collectCall(recipient: EvmAddress, tokenId: bigint, amount0Max: bigint, amount1Max: bigint): Hex {
  return encodeFunctionData({
    abi: positionManagerAbi,
    functionName: "collect",
    args: [{ tokenId, recipient, amount0Max, amount1Max }],
  });
}

/** The address a collect names when the tokens are to stay inside the manager. */
const MANAGER_ITSELF = "0x0000000000000000000000000000000000000000" as const;

/**
 * Empties a position into `recipient`, with the HBAR side arriving as HBAR. Three calls in one transaction: the
 * wrapped HBAR is collected into the manager, `unwrapWHBAR` sends it on natively, and the token side is collected
 * straight to the recipient. The two patterns a reader would try first both fail on Hedera — collecting both sides
 * into the manager reverts `TransferFail(184)` because the manager is not associated with the token, and collecting
 * both sides to the recipient hands over WHBAR tokens, which the recipient then has to unwrap itself.
 */
export function buildSplitCollect(request: { readonly tokenId: bigint; readonly recipient: EvmAddress }): PositionCall {
  const { tokenId, recipient } = request;
  const hbarToManager = collectCall(MANAGER_ITSELF, tokenId, MAX_UINT128, 0n);
  const unwrap = encodeFunctionData({
    abi: positionManagerAbi,
    functionName: "unwrapWHBAR",
    args: [0n, recipient],
  });
  const tokenToRecipient = collectCall(recipient, tokenId, 0n, MAX_UINT128);
  return {
    address: testnet.positionManager.evmAddress,
    abi: positionManagerAbi,
    functionName: "multicall",
    args: [[hbarToManager, unwrap, tokenToRecipient]],
  };
}

/**
 * Burns an empty position. The manager moves the NFT back to itself to do it, so it needs the owner's approval on
 * the NFT facade first, and that is a Hedera service check: `eth_call` and `eth_estimateGas` both accept a burn
 * without it and the network answers `HederaFail(292)` after charging the gas. Pass what `isApprovedForAll` on the
 * NFT facade answered; this refuses to build the call when it is false.
 */
export function buildBurn(request: { readonly tokenId: bigint; readonly approvedForAll: boolean }): PositionCall {
  if (!request.approvedForAll) {
    throw new PositionBuildError(
      "missing-nft-approval",
      `Position ${request.tokenId} cannot be burnt while ${testnet.positionManager.evmAddress} is not approved on ` +
        `${testnet.lpNft.symbol}: the burn moves the NFT back to the manager. Send setApprovalForAll first. ` +
        "Simulation does not catch this: it accepts the burn and the network answers HederaFail(292).",
    );
  }
  return {
    address: testnet.positionManager.evmAddress,
    abi: positionManagerAbi,
    functionName: "burn",
    args: [request.tokenId],
  };
}

/** Lets the position manager pull `amount` of the pool's token: the exact amount the mint offers. */
export function buildManagerTokenApproval(token: TokenEntry, amount: bigint): ApprovalCall {
  if (amount <= 0n) {
    throw new PositionBuildError("amount-out-of-range", `An approved amount of ${amount} lets the manager pull none.`);
  }
  assertHtsAmount(amount, "The approved amount");
  return {
    address: token.evmAddress,
    abi: htsTokenAbi,
    functionName: "approve",
    args: [testnet.positionManager.evmAddress, amount],
  };
}

/** Approves, or revokes, the position manager on the position NFT: what a burn needs and what a close leaves behind. */
export function buildNftApproval(approved: boolean): ApprovalCall {
  return {
    address: testnet.lpNft.evmAddress,
    abi: lpNftAbi,
    functionName: "setApprovalForAll",
    args: [testnet.positionManager.evmAddress, approved],
  };
}
