import { InvalidAddressError, getAddress, isAddress } from "viem";

// What this library means by an address, in one place.
//
// viem's own `Address` is whatever the project registers for abitype, and `packages/nextjs/types/abitype/abi.d.ts`
// registers `string` so that the stock hooks and the debug UI accept the addresses their inputs produce. That
// registration names viem's own copy of abitype by its path, and where the copy sits depends on which package
// manager installed the project: the same code would then type-check in one project and not in another. The types
// below never change, so what this library accepts and returns is the same in both.

/** A 20-byte EVM address: `0x` and 40 hexadecimal digits. */
export type EvmAddress = `0x${string}`;

/**
 * Whether `value` is a 20-byte hexadecimal address. With viem's default, a mixed-case address must also carry the
 * right checksum, which catches a mistyped digit; pass `{ strict: false }` for an address of any case.
 */
export function isEvmAddress(value: unknown, options?: { strict?: boolean }): value is EvmAddress {
  return typeof value === "string" && isAddress(value, options);
}

/**
 * The checksummed form of an address that arrives as a plain string: from a form field, from a wallet hook, or from
 * any type whose address abitype registers as `string`. It throws viem's own `InvalidAddressError` for anything
 * else, a mixed-case address whose checksum does not match included, so a mistyped address stops here instead of
 * costing gas. `getAddress` alone rewrites such an address to the checksum of what was typed.
 */
export function toEvmAddress(value: string): EvmAddress {
  if (!isEvmAddress(value)) throw new InvalidAddressError({ address: value });
  // getAddress returns nothing but a checksummed address, and its return type is viem's Address, which the
  // registration above turns into a plain string wherever it reaches viem.
  return getAddress(value) as EvmAddress;
}
