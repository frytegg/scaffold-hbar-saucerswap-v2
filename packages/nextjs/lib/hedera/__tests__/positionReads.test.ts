import { type EntityId, testnet } from "../addresses";
import type { EvmAddress } from "../evmAddress";
import { createMirrorClient } from "../mirror";
import { mirrorPaths } from "../mirrorPaths";
import {
  type PositionFields,
  positionStatus,
  readManagerAllowance,
  readMintFeeTinybar,
  readNftApproval,
  readPoolState,
  readPosition,
  readPositionSerials,
} from "../positionReads";
import { tinybar } from "../units";
import {
  type LifecycleFixture,
  type PoolEventsFixture,
  mirrorFixture,
  positionFixture,
  replayClient,
  replayMirror,
  rpcFixture,
} from "./replay";
import { describe, expect, it } from "vitest";

const MAIN: EvmAddress = "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01";
const HOLDER: EntityId = "0.0.10542434";
const pool = positionFixture<PoolEventsFixture>("hbar-sauce-pool-events");
const lifecycle = positionFixture<LifecycleFixture>("serial-360-lifecycle");

const reads = replayClient([
  rpcFixture("call-pool-slot0"),
  rpcFixture("call-pool-tick-spacing"),
  rpcFixture("call-pool-liquidity"),
  rpcFixture("call-positions-open"),
  rpcFixture("call-factory-mint-fee"),
  rpcFixture("call-tinycents-to-tinybars"),
  rpcFixture("call-lp-nft-approved"),
  rpcFixture("call-manager-allowance"),
]);

describe("the serials an account holds, which the token facade cannot enumerate", () => {
  const mirror = (account: EntityId, fixture: string) =>
    createMirrorClient({
      transport: replayMirror({
        [mirrorPaths.accountNfts(account, testnet.lpNft.id, 100)]: mirrorFixture(fixture),
      }),
    });

  it("lists them from the mirror node, oldest first", async () => {
    const held = await readPositionSerials(mirror(HOLDER, "nfts-two-positions"), HOLDER);
    expect(held).toEqual({ serials: [357n, 358n], hasMore: false });
  });

  it("answers an empty list for an account that holds none, without throwing", async () => {
    expect(await readPositionSerials(mirror("0.0.10645914", "nfts-none"), "0.0.10645914")).toEqual({
      serials: [],
      hasMore: false,
    });
  });

  it("asks the mirror node for the collection this template's positions belong to", async () => {
    const transport = replayMirror({
      [mirrorPaths.accountNfts(HOLDER, testnet.lpNft.id, 100)]: mirrorFixture("nfts-two-positions"),
    });
    await readPositionSerials(createMirrorClient({ transport }), HOLDER);
    expect(transport.requested).toEqual([`/api/v1/accounts/${HOLDER}/nfts?token.id=0.0.1310436&limit=100&order=asc`]);
  });
});

describe("one position, read through the position manager's ten fields", () => {
  it("decodes the fields of a position a third party still holds", async () => {
    const position = await readPosition(reads, 357n);
    expect(position).toEqual({
      tokenId: 357n,
      token0: testnet.whbar.evmAddress,
      token1: testnet.sauce.evmAddress,
      fee: testnet.hbarSaucePool.fee,
      tickLower: -887220,
      tickUpper: 887220,
      liquidity: 34039924n,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
    });
  });

  it("answers null for a burnt serial, which the manager refuses rather than empties", async () => {
    const burnt = replayClient([rpcFixture("call-positions-burnt")]);
    expect(await readPosition(burnt, 360n)).toBeNull();
  });
});

describe("the pool's live state and the fee a mint pays", () => {
  it("reads the price, the tick and the spacing the fixture recorded", async () => {
    const state = await readPoolState(reads, testnet.hbarSaucePool);
    expect(state.tickSpacing).toBe(pool.pool.tickSpacing);
    expect(state.tick).toBe(-7643);
    expect(state.sqrtPriceX96).toBeGreaterThan(0n);
    expect(state.liquidity).toBeGreaterThan(0n);
  });

  it("takes the fee from the factory and converts it through the exchange-rate contract", async () => {
    const fee = await readMintFeeTinybar(reads);
    const mint = lifecycle.transactions.find(transaction => transaction.step === "mint");
    if (mint === undefined) throw new Error("the life-cycle fixture holds the mint");
    // The value that mint carried was the HBAR leg plus this fee and its margin: the fee is under the whole value.
    expect(fee).toBeGreaterThan(0n);
    expect(fee).toBeLessThan(BigInt(mint.valueTinybar));
  });

  it("reads the manager's own allowance and the NFT approval, neither of which a simulation checks", async () => {
    expect(await readManagerAllowance(reads, testnet.sauce, MAIN)).toBeGreaterThanOrEqual(0n);
    expect(await readNftApproval(reads, MAIN)).toBe(true);
  });
});

describe("what a position is worth and what closing it would return", () => {
  const closed = lifecycle.transactions.find(transaction => transaction.step === "collect");
  const mintEvent = pool.events.find(event => event.event === "Mint" && event.liquidity === "15562884336");
  const burnEvent = pool.events.find(event => event.event === "Burn" && event.liquidity === "15562884336");

  const position = (liquidity: bigint, owed0: bigint, owed1: bigint): PositionFields => ({
    tokenId: 360n,
    token0: testnet.whbar.evmAddress,
    token1: testnet.sauce.evmAddress,
    fee: testnet.hbarSaucePool.fee,
    tickLower: -7680,
    tickUpper: -7620,
    liquidity,
    tokensOwed0: owed0,
    tokensOwed1: owed1,
  });

  it("returns what the split collect really paid out for position 360", () => {
    if (burnEvent === undefined || closed === undefined) throw new Error("the fixtures hold the close of serial 360");
    const collected = closed.events.filter(event => event.name === "Collect" && "tokenId" in event.args);
    const paid0 = collected.reduce((total, event) => total + BigInt(event.args.amount0), 0n);
    const paid1 = collected.reduce((total, event) => total + BigInt(event.args.amount1), 0n);

    const status = positionStatus(position(BigInt(burnEvent.liquidity), 0n, 0n), {
      sqrtPriceX96: BigInt(burnEvent.sqrtPriceX96Before),
      tick: burnEvent.tickBefore,
      tickSpacing: pool.pool.tickSpacing,
      liquidity: 0n,
    });
    expect(status.closeReturns).toEqual({ amount0: paid0, amount1: paid1 });
    expect(status.range).toBe("in-range");
  });

  it("adds the fees a position earned, which is why serial 359 paid out more than it held", () => {
    const close = positionFixture<LifecycleFixture>("serial-359-close");
    const removed = close.transactions.find(transaction => transaction.step === "decrease");
    const collected = close.transactions.find(transaction => transaction.step === "collect");
    const priced = pool.events.find(event => event.event === "Burn" && event.liquidity === "43860633182");
    if (removed === undefined || collected === undefined || priced === undefined) {
      throw new Error("the fixtures hold the close of serial 359");
    }
    const paidOut = collected.events
      .filter(event => event.name === "Collect")
      .reduce((total, event) => total + BigInt(event.args.amount0), 0n);
    const principal0 = BigInt(priced.amount0);
    const status = positionStatus(position(BigInt(priced.liquidity), paidOut - principal0, 0n), {
      sqrtPriceX96: BigInt(priced.sqrtPriceX96Before),
      tick: priced.tickBefore,
      tickSpacing: pool.pool.tickSpacing,
      liquidity: 0n,
    });
    expect(status.principal.amount0).toBe(principal0);
    expect(status.closeReturns.amount0).toBe(paidOut);
  });

  it("says which side of the range the price left a position on", () => {
    if (mintEvent === undefined) throw new Error("the fixtures hold the mint of serial 360");
    const state = {
      sqrtPriceX96: BigInt(mintEvent.sqrtPriceX96Before),
      tickSpacing: pool.pool.tickSpacing,
      liquidity: 0n,
    };
    const held = position(BigInt(mintEvent.liquidity), 0n, 0n);
    expect(positionStatus(held, { ...state, tick: mintEvent.tickBefore }).range).toBe("in-range");
    expect(positionStatus({ ...held, tickLower: -600, tickUpper: -540 }, { ...state, tick: -7643 }).range).toBe(
      "below",
    );
    expect(positionStatus({ ...held, tickLower: -12000, tickUpper: -11400 }, { ...state, tick: -7643 }).range).toBe(
      "above",
    );
  });

  it("keeps the amounts in tinybar for the HBAR side, which is what the pool reports", () => {
    if (burnEvent === undefined) throw new Error("the fixtures hold the burn of serial 360");
    const status = positionStatus(position(BigInt(burnEvent.liquidity), 0n, 0n), {
      sqrtPriceX96: BigInt(burnEvent.sqrtPriceX96Before),
      tick: burnEvent.tickBefore,
      tickSpacing: pool.pool.tickSpacing,
      liquidity: 0n,
    });
    expect(tinybar(status.principal.amount0)).toBe(BigInt(burnEvent.amount0));
  });
});
