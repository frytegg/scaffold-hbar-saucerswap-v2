import type { EvmAddress } from "./evmAddress";

/** A Hedera entity id, `shard.realm.num`. */
export type EntityId = `${number}.${number}.${number}`;

export type AddressBookEntry = {
  readonly id: EntityId;
  readonly evmAddress: EvmAddress;
  /** Where the id is published. */
  readonly source: string;
  /** UTC date of the last check on the testnet mirror node: EVM address, bytecode or token metadata, not deleted. */
  readonly checkedOn: string;
};

export type TokenEntry = AddressBookEntry & { readonly symbol: string; readonly decimals: number };

/** A pool that pairs HBAR (as WHBAR) with `token`, at `fee` hundredths of a basis point. */
export type HbarPoolEntry = AddressBookEntry & { readonly token: TokenEntry; readonly fee: number };

const SAUCERSWAP_DOCS = "https://docs.saucerswap.finance/developers/contracts#hedera-testnet";
const HEDERA_SYSTEM_CONTRACTS = "https://docs.hedera.com/hedera/core-concepts/smart-contracts/system-smart-contracts";
const CHECKED_ON = "2026-09-22";
/** The entries the position slice added: token metadata, pool getters and the fee conversion read on that day. */
const CHECKED_ON_POSITIONS = "2026-09-23";

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
  /** Ask it for a pool with getPool: testnet pools were created with another init-code hash than the published one. */
  v2Factory: {
    id: "0.0.1197038",
    evmAddress: "0x00000000000000000000000000000000001243eE",
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
  /** The contract behind that token: it holds the wrapped HBAR and pays it out when the router unwraps. */
  whbarContract: {
    id: "0.0.15057",
    evmAddress: "0x0000000000000000000000000000000000003aD1",
    source: SAUCERSWAP_DOCS,
    checkedOn: CHECKED_ON,
  },
  sauce,
  /** Holds the V2 liquidity positions. Its mint is the call no simulator prices: see gasRules.ts. */
  positionManager: {
    id: "0.0.1308184",
    evmAddress: "0x000000000000000000000000000000000013F618",
    source: SAUCERSWAP_DOCS,
    checkedOn: CHECKED_ON,
  },
  /** A position is an HTS NFT, and its facade has no enumeration: the serials come from the mirror node. */
  lpNft: {
    id: "0.0.1310436",
    evmAddress: "0x000000000000000000000000000000000013feE4",
    symbol: "SSV2-LP",
    decimals: 0,
    source: SAUCERSWAP_DOCS,
    checkedOn: CHECKED_ON_POSITIONS,
  },
  /**
   * The exchange-rate system contract. A position's mint fee is quoted in tinycent and charged in HBAR at the rate
   * this contract answers, which is not the rate the mirror node's REST endpoint serves.
   */
  exchangeRate: {
    id: "0.0.360",
    evmAddress: "0x0000000000000000000000000000000000000168",
    source: HEDERA_SYSTEM_CONTRACTS,
    checkedOn: CHECKED_ON_POSITIONS,
  },
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
  v2Factory: AddressBookEntry;
  whbar: TokenEntry;
  whbarContract: AddressBookEntry;
  sauce: TokenEntry;
  positionManager: AddressBookEntry;
  lpNft: TokenEntry;
  exchangeRate: AddressBookEntry;
  hbarSaucePool: HbarPoolEntry;
};
