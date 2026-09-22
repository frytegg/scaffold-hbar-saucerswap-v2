import type { AddressBookEntry } from "../addresses";
import { testnet } from "../addresses";
import type { EvidenceSwap } from "../evidence";
import { type EvmAddress, isEvmAddress, toEvmAddress } from "../evmAddress";
import type { MirrorAccount, MirrorContractResult } from "../mirror";
import type { checkCost } from "../preflight";
import { type SwapCall, buildHbarToTokenSwap } from "../swap";
import { hbarToTinybar } from "../units";
import { describe, expect, expectTypeOf, it } from "vitest";

const MAIN = "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01";
// The same address with one letter's case flipped: a checksum that no longer matches, which is what a mistyped
// digit looks like.
const MISTYPED = "0x3B7A9A1B874Dd0994cc4137047daCF2803Bb6C01";

describe("an address is 0x and 40 hexadecimal digits, whatever the project registers for abitype", () => {
  it("returns the checksummed form of an address written in any case", () => {
    expect(toEvmAddress(MAIN)).toBe(MAIN);
    expect(toEvmAddress(MAIN.toLowerCase())).toBe(MAIN);
    expect(toEvmAddress("0x0000000000000000000000000000000000003ad2")).toBe(testnet.whbar.evmAddress);
  });

  it("refuses an account id, a short address and a checksum that does not match", () => {
    expect(() => toEvmAddress("0.0.10645914")).toThrow('Address "0.0.10645914" is invalid.');
    expect(() => toEvmAddress(MAIN.slice(0, -2))).toThrow("is invalid");
    // viem's getAddress would answer the checksum of what was typed; a mistyped digit has to stop here.
    expect(() => toEvmAddress(MISTYPED)).toThrow('Address "0x3B7A9A1B874Dd0994cc4137047daCF2803Bb6C01" is invalid.');
  });

  it("narrows a value of any type, and takes any case only when asked", () => {
    expect(isEvmAddress(MAIN)).toBe(true);
    expect(isEvmAddress(MAIN.toLowerCase())).toBe(true);
    expect(isEvmAddress(null)).toBe(false);
    expect(isEvmAddress("0.0.10645914")).toBe(false);
    expect(isEvmAddress(MISTYPED)).toBe(false);
    expect(isEvmAddress(MISTYPED, { strict: false })).toBe(true);
  });

  it("takes an address that reaches the code as a plain string into a swap", () => {
    const fromAForm: string = MAIN.toLowerCase();
    const swap = buildHbarToTokenSwap({
      pool: testnet.hbarSaucePool,
      recipient: toEvmAddress(fromAForm),
      slippageBps: 500,
      deadline: 1_790_024_196n,
      amountIn: hbarToTinybar("1"),
      quotedAmountOut: 46_434_742n,
    });
    expect(swap.address).toBe(testnet.swapRouter.evmAddress);
  });
});

// These assertions are checked by the type check, not by the runner: each one fails `typecheck` as soon as a public
// type of this library takes its address from viem again, whose own is a plain string wherever the project's
// registration in types/abitype/abi.d.ts reaches it.
describe("the library's public types are the same under every install", () => {
  it("types every address it accepts and returns the same way", () => {
    expectTypeOf<EvmAddress>().toEqualTypeOf<`0x${string}`>();
    expectTypeOf<AddressBookEntry["evmAddress"]>().toEqualTypeOf<EvmAddress>();
    expectTypeOf<MirrorAccount["evmAddress"]>().toEqualTypeOf<EvmAddress>();
    expectTypeOf<MirrorContractResult["from"]>().toEqualTypeOf<EvmAddress>();
    expectTypeOf<SwapCall["address"]>().toEqualTypeOf<EvmAddress>();
    expectTypeOf<EvidenceSwap["recipient"]>().toEqualTypeOf<EvmAddress>();
    expectTypeOf<Parameters<typeof buildHbarToTokenSwap>[0]["recipient"]>().toEqualTypeOf<EvmAddress>();
    expectTypeOf<Parameters<typeof checkCost>[1]["account"]>().toEqualTypeOf<EvmAddress>();
  });
});
