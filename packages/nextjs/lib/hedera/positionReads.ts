import { htsTokenAbi } from "./abi";
import { type EntityId, type HbarPoolEntry, type TokenEntry, testnet } from "./addresses";
import { type EvmAddress, toEvmAddress } from "./evmAddress";
import { type PositionAmounts, type PositionRange, amountsForLiquidity, rangeOfPosition } from "./liquidityMath";
import { MAX_MIRROR_PAGE, type MirrorClient } from "./mirror";
import { exchangeRateAbi, lpNftAbi, positionManagerAbi, v2FactoryFeeAbi, v2PoolAbi } from "./positionAbi";
import { extractRpcError } from "./rpcError";
import { type Tinybar, tinybar } from "./units";
import type { PublicClient } from "viem";

// Reading a position takes two sources, because neither has all of it. The HTS facade that holds the position NFT
// has no enumeration, so which serials an account owns comes from the mirror node; what is inside a serial comes
// from the position manager, whose `positions` answers ten fields where the Uniswap ABI of the same selector
// expects twelve. Nothing here signs or spends.

export type PositionFields = {
  readonly tokenId: bigint;
  readonly token0: EvmAddress;
  readonly token1: EvmAddress;
  /** Hundredths of a basis point, as the pool's own `fee()` reports it. */
  readonly fee: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  /** Already taken out of the pool and waiting in the manager: earned fees, and anything a decrease left behind. */
  readonly tokensOwed0: bigint;
  readonly tokensOwed1: bigint;
};

export type PoolState = {
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly tickSpacing: number;
  /** The liquidity of the whole pool at that tick, which is what a swap moves against. */
  readonly liquidity: bigint;
};

export type PositionStatus = {
  readonly position: PositionFields;
  readonly range: PositionRange;
  /** What the liquidity is worth at the live price, rounded down as a withdrawal is. */
  readonly principal: PositionAmounts;
  readonly owed: PositionAmounts;
  /** Principal plus what is already owed: what closing the position would hand over. */
  readonly closeReturns: PositionAmounts;
};

/**
 * The serials of the position collection an account holds, oldest first, and whether the mirror node has more of
 * them than one page holds. `limit` is that page's size, at most `MAX_MIRROR_PAGE`: a caller that drops `hasMore`
 * shows a holder part of their positions as if it were all of them.
 */
export async function readPositionSerials(
  mirror: MirrorClient,
  account: EntityId | EvmAddress,
  limit: number = MAX_MIRROR_PAGE,
): Promise<{ serials: bigint[]; hasMore: boolean }> {
  const page = await mirror.getAccountNfts(account, testnet.lpNft.id, limit);
  return { serials: page.nfts.map(nft => nft.serialNumber), hasMore: page.hasMore };
}

/**
 * The ten fields of one position, or null when the manager does not know the serial: a burnt position answers a
 * revert, not an empty struct, and so does a serial that was never minted.
 */
export async function readPosition(client: PublicClient, tokenId: bigint): Promise<PositionFields | null> {
  try {
    const fields = await client.readContract({
      address: testnet.positionManager.evmAddress,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [tokenId],
    });
    const [token0, token1, fee, tickLower, tickUpper, liquidity, , , tokensOwed0, tokensOwed1] = fields;
    return {
      tokenId,
      // An address out of an ABI is a plain string in this project: the door that returns this library's own type.
      token0: toEvmAddress(token0),
      token1: toEvmAddress(token1),
      fee,
      tickLower,
      tickUpper,
      liquidity,
      tokensOwed0,
      tokensOwed1,
    };
  } catch (error: unknown) {
    const refusal = extractRpcError(error);
    if (refusal.data !== null || refusal.code === 3) return null;
    throw error;
  }
}

export async function readPoolState(client: PublicClient, pool: HbarPoolEntry): Promise<PoolState> {
  const read = { address: pool.evmAddress, abi: v2PoolAbi } as const;
  const [slot0, tickSpacing, liquidity] = await Promise.all([
    client.readContract({ ...read, functionName: "slot0" }),
    client.readContract({ ...read, functionName: "tickSpacing" }),
    client.readContract({ ...read, functionName: "liquidity" }),
  ]);
  return { sqrtPriceX96: slot0[0], tick: slot0[1], tickSpacing, liquidity };
}

/**
 * What opening a position costs on top of the liquidity, in tinybar. The factory quotes the fee in tinycent — the
 * position manager itself does not answer `mintFee` — and only the exchange-rate system contract converts it at the
 * rate the network charges at: the mirror node's REST rate was six days stale and 1.25 % away on 21 Sept 2026.
 */
export async function readMintFeeTinybar(client: PublicClient): Promise<Tinybar> {
  const tinycents = await client.readContract({
    address: testnet.v2Factory.evmAddress,
    abi: v2FactoryFeeAbi,
    functionName: "mintFee",
  });
  const { result } = await client.simulateContract({
    address: testnet.exchangeRate.evmAddress,
    abi: exchangeRateAbi,
    functionName: "tinycentsToTinybars",
    args: [tinycents],
  });
  return tinybar(result);
}

/** How much of `token` the position manager may pull from `owner`. The router's own allowance does not cover a mint. */
export async function readManagerAllowance(
  client: PublicClient,
  token: TokenEntry,
  owner: EvmAddress,
): Promise<bigint> {
  return client.readContract({
    address: token.evmAddress,
    abi: htsTokenAbi,
    functionName: "allowance",
    args: [owner, testnet.positionManager.evmAddress],
  });
}

/** Whether the position manager may move `owner`'s position NFTs, which is what a burn needs. */
export async function readNftApproval(client: PublicClient, owner: EvmAddress): Promise<boolean> {
  return client.readContract({
    address: testnet.lpNft.evmAddress,
    abi: lpNftAbi,
    functionName: "isApprovedForAll",
    args: [owner, testnet.positionManager.evmAddress],
  });
}

/**
 * Where a position stands against the live price, and what closing it would return. Outside its range one of the
 * two amounts is zero and the position earns no fee, which is the state a holder has to be shown before deciding.
 */
export function positionStatus(position: PositionFields, pool: PoolState): PositionStatus {
  const { tickLower, tickUpper, liquidity, tokensOwed0, tokensOwed1 } = position;
  const principal = amountsForLiquidity(
    { sqrtPriceX96: pool.sqrtPriceX96, tickLower, tickUpper, liquidity },
    "withdraw",
  );
  const owed: PositionAmounts = { amount0: tokensOwed0, amount1: tokensOwed1 };
  return {
    position,
    range: rangeOfPosition({ tick: pool.tick, tickLower, tickUpper }),
    principal,
    owed,
    closeReturns: {
      amount0: principal.amount0 + owed.amount0,
      amount1: principal.amount1 + owed.amount1,
    },
  };
}
