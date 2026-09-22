import { entityIdOfLongZero, isLongZeroAddress, isSentBy } from "../addressForms";
import { type AddressBookEntry, testnet } from "../addresses";
import { createMirrorClient } from "../mirror";
import { mirrorPaths } from "../mirrorPaths";
import { mirrorBody, mirrorFixture, replayMirror } from "./replay";
import { getAddress } from "viem";
import { hederaTestnet } from "viem/chains";
import { describe, expect, it } from "vitest";

const entries: [string, AddressBookEntry][] = [
  ["swapRouter", testnet.swapRouter],
  ["quoterV2", testnet.quoterV2],
  ["whbar", testnet.whbar],
  ["sauce", testnet.sauce],
  ["hbarSaucePool", testnet.hbarSaucePool],
];

describe("the testnet address book", () => {
  it("is for chain 296 only", () => {
    expect(testnet.chainId).toBe(hederaTestnet.id);
  });

  it.each(entries)("%s carries a checksummed address, a source URL and a check date", (_name, entry) => {
    expect(getAddress(entry.evmAddress)).toBe(entry.evmAddress);
    expect(entry.source).toMatch(/^https:\/\//);
    expect(entry.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each(entries.filter(([name]) => name !== "hbarSaucePool"))(
    "%s is the long-zero form of its id",
    (_name, entry) => {
      expect(entityIdOfLongZero(entry.evmAddress)).toBe(entry.id);
    },
  );

  it("the pool is a contract created by the factory, not a long-zero address", () => {
    expect(isLongZeroAddress(testnet.hbarSaucePool.evmAddress)).toBe(false);
    expect(testnet.hbarSaucePool.token).toBe(testnet.sauce);
  });

  it("matches the router our own swaps were sent to", () => {
    for (const fixture of ["result-hbar-to-token-success", "result-token-to-hbar-success"]) {
      expect(getAddress(mirrorBody(fixture).to as string)).toBe(testnet.swapRouter.evmAddress);
    }
  });
});

describe("address forms", () => {
  const main = mirrorBody("account-unlimited-slots");

  it("tells a long-zero address from an account's own EVM address", () => {
    expect(isLongZeroAddress("0x0000000000000000000000000000000000a2719a")).toBe(true);
    expect(isLongZeroAddress(main.evm_address as `0x${string}`)).toBe(false);
  });

  it("reads the account id out of a long-zero address, and nothing out of another address", () => {
    expect(entityIdOfLongZero("0x0000000000000000000000000000000000a2719a")).toBe("0.0.10645914");
    expect(entityIdOfLongZero(main.evm_address as `0x${string}`)).toBeNull();
  });

  it("recognises the sender of a mirror result although `from` is long-zero, which a plain comparison misses", async () => {
    const mirror = createMirrorClient({
      transport: replayMirror({
        [mirrorPaths.contractResult(mirrorBody("result-token-to-hbar-success").hash as `0x${string}`)]:
          mirrorFixture("result-token-to-hbar-success"),
        [mirrorPaths.account("0.0.10645914")]: mirrorFixture("account-unlimited-slots"),
        [mirrorPaths.account("0.0.10574825")]: mirrorFixture("account-zero-slots-unassociated"),
      }),
    });
    const result = await mirror.getContractResult(mirrorBody("result-token-to-hbar-success").hash as `0x${string}`);
    const sender = await mirror.getAccount("0.0.10645914");
    const someoneElse = await mirror.getAccount("0.0.10574825");
    if (result === null || sender === null || someoneElse === null) throw new Error("fixture missing");

    expect(result.from.toLowerCase()).not.toBe(sender.evmAddress.toLowerCase());
    expect(isSentBy(result, sender)).toBe(true);
    expect(isSentBy(result, someoneElse)).toBe(false);
  });
});
