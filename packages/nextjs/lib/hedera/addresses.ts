import type { Address } from "viem";

/** A Hedera entity id, `shard.realm.num`. */
export type EntityId = `${number}.${number}.${number}`;

export type AddressBookEntry = {
  readonly id: EntityId;
  readonly evmAddress: Address;
  /** Where the id is published. */
  readonly source: string;
  /** UTC date of the last check on the testnet mirror node: EVM address, bytecode or token metadata, not deleted. */
  readonly checkedOn: string;
};

export type TokenEntry = AddressBookEntry & { readonly symbol: string; readonly decimals: number };

/** A pool that pairs HBAR (as WHBAR) with `token`, at `fee` hundredths of a basis point. */
export type HbarPoolEntry = AddressBookEntry & { readonly token: TokenEntry; readonly fee: number };

const SAUCERSWAP_DOCS = "https://docs.saucerswap.finance/developers/contracts#hedera-testnet";
const CHECKED_ON = "2026-09-22";

const sauce: TokenEntry = {
  id: "0.0.1183558",
  evmAddress: "0x0000000000000000000000000000000000120f46",
  symbol: "SAUCE",
  decimals: 6,
  source: SAUCERSWAP_DOCS,
  checkedOn: CHECKED_ON,
};

/**
 * Every contract and token this template calls or pays through, on Hedera testnet (chain 296) only: nothing here
 * has been executed on mainnet. Copy addresses from this file, never retype them.
 */
export const testnet = {
  chainId: 296,
  swapRouter: {
    id: "0.0.1414040",
    evmAddress: "0x0000000000000000000000000000000000159398",
    source: SAUCERSWAP_DOCS,
    checkedOn: CHECKED_ON,
  },
  quoterV2: {
    id: "0.0.1390002",
    evmAddress: "0x00000000000000000000000000000000001535B2",
    source: SAUCERSWAP_DOCS,
    checkedOn: CHECKED_ON,
  },
  /** The WHBAR token that swap paths name for HBAR; the router wraps and unwraps it itself. */
  whbar: {
    id: "0.0.15058",
    evmAddress: "0x0000000000000000000000000000000000003aD2",
    symbol: "WHBAR",
    decimals: 8,
    source: SAUCERSWAP_DOCS,
    checkedOn: CHECKED_ON,
  },
  sauce,
  /** Checked as what the V2 factory (0.0.1197038) returns for getPool(WHBAR, SAUCE, 3000). */
  hbarSaucePool: {
    id: "0.0.2661057",
    evmAddress: "0x37814eDc1ae88cf27c0C346648721FB04e7E0AE7",
    token: sauce,
    fee: 3000,
    source: "https://hashscan.io/testnet/contract/0.0.2661057",
    checkedOn: CHECKED_ON,
  },
} as const satisfies {
  chainId: number;
  swapRouter: AddressBookEntry;
  quoterV2: AddressBookEntry;
  whbar: TokenEntry;
  sauce: TokenEntry;
  hbarSaucePool: HbarPoolEntry;
};
