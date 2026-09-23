import { type Tinybar, WEIBAR_PER_TINYBAR, tinybar } from "./units";

// What a transaction can cost, and why the figure a wallet displays is not the figure the network charges.

/** Where the gas of a preview came from. */
export type CostSource =
  /** eth_estimateGas, through viem, for this sender and these arguments. */
  | "estimate"
  /** The gas limit of a rule in gasRules.ts, for a call neither simulator will price. */
  | "gas-rule";

/**
 * The fee `gas` costs at `gasPrice` (weibar per gas, as eth_gasPrice answers), rounded up to the tinybar. It is an
 * upper bound twice over: the gas is a limit or an estimate above what the call uses, and the network charged an
 * effective price below eth_gasPrice on every transaction this project has sent.
 */
export function feeForGas(gas: bigint, gasPrice: bigint): Tinybar {
  return tinybar((gas * gasPrice + WEIBAR_PER_TINYBAR - 1n) / WEIBAR_PER_TINYBAR);
}

/**
 * Why a wallet announces more than the network takes. MetaMask 13.48.0 priced the gas LIMIT at eth_gasPrice on all
 * eight transactions measured on 22 Sept 2026, while each one was charged for the gas it used at a lower effective
 * price: `lib/hedera/__tests__/fixtures/wallet/metamask-fee-display.json` holds the eight pairs. It says "about the
 * same" because this preview is an estimate while the wallet prices its own limit; the two coincided on those eight
 * because the limit was the relay's own estimate, and no wallet has yet been measured on this route.
 */
export const WALLET_FEE_NOTE =
  "Your wallet announces about the same figure, because it prices the gas limit at the current gas price. The " +
  "network charges only the gas the call uses, so what leaves the account is smaller on every transaction this " +
  "project has measured.";
