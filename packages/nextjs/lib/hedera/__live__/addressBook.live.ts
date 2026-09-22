import { htsTokenAbi, swapRouterAbi, v2FactoryAbi } from "../abi";
import { type AddressBookEntry, type TokenEntry, testnet } from "../addresses";
import { quoteExactInput, swapPath } from "../swap";
import { formatTokenAmount, hbarToTinybar } from "../units";
import { testnetClient, testnetMirror } from "./testnet";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

const entries: [string, AddressBookEntry][] = [
  ["swapRouter", testnet.swapRouter],
  ["quoterV2", testnet.quoterV2],
  ["v2Factory", testnet.v2Factory],
  ["whbar", testnet.whbar],
  ["whbarContract", testnet.whbarContract],
  ["sauce", testnet.sauce],
  ["hbarSaucePool", testnet.hbarSaucePool],
];

const readRouter = (functionName: "factory" | "whbar" | "WHBAR") =>
  testnetClient.readContract({ address: testnet.swapRouter.evmAddress, abi: swapRouterAbi, functionName });

describe("the address book still describes SaucerSwap V2 on Hedera testnet", () => {
  it("the JSON-RPC relay serves chain 296", async () => {
    expect(await testnetClient.getChainId()).toBe(testnet.chainId);
  });

  it.each(entries)("%s has code at its address", async (_name, entry) => {
    const code = await testnetClient.getCode({ address: entry.evmAddress });
    expect(code?.length ?? 0).toBeGreaterThan(2);
  });

  it("the router's factory() is the address book's V2 factory", async () => {
    expect(await readRouter("factory")).toBe(testnet.v2Factory.evmAddress);
  });

  it("the router's whbar() is the WHBAR token of the swap paths, and its WHBAR() the WHBAR contract", async () => {
    expect(await readRouter("whbar")).toBe(testnet.whbar.evmAddress);
    expect(await readRouter("WHBAR")).toBe(testnet.whbarContract.evmAddress);
  });

  it("the factory's getPool(WHBAR, SAUCE, 3000) is the address book's HBAR/SAUCE pool", async () => {
    const pool = await testnetClient.readContract({
      address: testnet.v2Factory.evmAddress,
      abi: v2FactoryAbi,
      functionName: "getPool",
      args: [testnet.whbar.evmAddress, testnet.hbarSaucePool.token.evmAddress, testnet.hbarSaucePool.fee],
    });
    expect(getAddress(pool)).toBe(testnet.hbarSaucePool.evmAddress);
  });

  it.each<[string, TokenEntry]>([
    ["whbar", testnet.whbar],
    ["sauce", testnet.sauce],
  ])("%s answers the address book's symbol and decimals", async (_name, token) => {
    const read = (functionName: "symbol" | "decimals") =>
      testnetClient.readContract({ address: token.evmAddress, abi: htsTokenAbi, functionName });
    expect(await read("symbol")).toBe(token.symbol);
    expect(await read("decimals")).toBe(token.decimals);
  });

  // The router and the quoter accept only the tokens their owner associated with them, and have no free slot.
  it.each(
    (["swapRouter", "quoterV2"] as const).flatMap(contract =>
      [testnet.whbar, testnet.sauce].map(token => ({ contract, token: token.symbol, tokenId: token.id })),
    ),
  )("$contract is associated with $token", async ({ contract, tokenId }) => {
    expect(await testnetMirror.getTokenRelationship(testnet[contract].id, tokenId)).not.toBeNull();
  });

  it("QuoterV2 quotes 1 HBAR -> SAUCE", async () => {
    const amountOut = await quoteExactInput(
      testnetClient,
      swapPath(testnet.whbar, testnet.hbarSaucePool.fee, testnet.sauce),
      hbarToTinybar("1"),
    );
    console.info(`QuoterV2: 1 HBAR -> ${formatTokenAmount(amountOut, testnet.sauce)}`);
    expect(amountOut).toBeGreaterThan(0n);
  });
});
