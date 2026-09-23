import { htsTokenAbi } from "./abi";
import { isLongZeroAddress } from "./addressForms";
import { type TokenEntry, testnet } from "./addresses";
import { type CostSource, WALLET_FEE_NOTE, feeForGas } from "./cost";
import type { EvmAddress } from "./evmAddress";
import { type FailureAction, explainResponseCode } from "./failure";
import { gasRuleFor } from "./gasRules";
import type { MirrorAccount, MirrorClient, MirrorTokenRelationship } from "./mirror";
import { SUCCESS_CODE } from "./responseCodes";
import type { BuiltCall } from "./swap";
import { type Tinybar, formatHbar, formatTokenAmount } from "./units";
import type { PublicClient } from "viem";

// Checks for what a simulation passes wrongly or does not show, run before the wallet is asked to sign. "fail" blocks
// the send, "warn" lets it go with the message shown.

export type PreflightCheck =
  | "allowance"
  | "recipient"
  | "facade-result"
  | "cost"
  // The four a position adds, in positionPreflight.ts: the position manager's own allowance on the pool's token,
  // room for the position NFT, the NFT approval a burn needs, and the value that has to cover the mint fee.
  | "manager-allowance"
  | "lp-nft-slot"
  | "nft-approval"
  | "mint-value"
  | "minimums";

export type PreflightVerdict = {
  check: PreflightCheck;
  status: "pass" | "warn" | "fail";
  message: string;
  action: FailureAction;
};

export type RecipientVerdict = PreflightVerdict & {
  /** The recipient's first receipt of the token associates it inside the swap, which then costs more gas. */
  autoAssociates: boolean;
};

export type CostVerdict = PreflightVerdict & {
  gas: bigint;
  fee: Tinybar;
  source: CostSource;
  /** Why the wallet's own figure is this same upper bound, and the network's charge is not. */
  walletNote: string;
};

/**
 * The router's allowance must cover the whole input amount. Without it the network rejects the swap (292, or 293 when
 * the allowance is too small) and still charges the gas, while on Hedera testnet (relay 0.78.5, 21 and 22 Sept 2026)
 * eth_call and eth_estimateGas accepted that same swap, so its simulation gave no warning.
 */
export function allowanceVerdict(allowance: bigint, amountIn: bigint, token: TokenEntry): PreflightVerdict {
  const needed = formatTokenAmount(amountIn, token);
  if (allowance >= amountIn) {
    return {
      check: "allowance",
      status: "pass",
      action: "none",
      message: `The router may spend the ${needed} of this swap.`,
    };
  }
  const current =
    allowance === 0n
      ? `The SaucerSwap router has no allowance to spend your ${token.symbol}.`
      : `The SaucerSwap router may spend only ${formatTokenAmount(allowance, token)}, less than the ${needed} of this swap.`;
  return {
    check: "allowance",
    status: "fail",
    action: "approve",
    message: `${current} Approve ${needed} first: without it the network rejects the swap and still charges the gas.`,
  };
}

export async function readAllowance(client: PublicClient, token: TokenEntry, owner: EvmAddress): Promise<bigint> {
  return client.readContract({
    address: token.evmAddress,
    abi: htsTokenAbi,
    functionName: "allowance",
    args: [owner, testnet.swapRouter.evmAddress],
  });
}

export async function checkAllowance(
  client: PublicClient,
  { token, owner, amountIn }: { token: TokenEntry; owner: EvmAddress; amountIn: bigint },
): Promise<PreflightVerdict> {
  return allowanceVerdict(await readAllowance(client, token, owner), amountIn, token);
}

/**
 * Whether `recipient` can receive `token`: it must exist, be given by its own EVM address when it has one, and be
 * associated with the token or have a free automatic association slot. Without a slot the swap reverts on chain.
 */
export function recipientVerdict(
  recipient: EvmAddress,
  account: MirrorAccount | null,
  relationship: MirrorTokenRelationship | null,
  token: TokenEntry,
): RecipientVerdict {
  const verdict = (
    status: PreflightVerdict["status"],
    action: FailureAction,
    message: string,
    autoAssociates = false,
  ) => ({
    check: "recipient" as const,
    status,
    action,
    message,
    autoAssociates,
  });

  if (account === null) {
    return verdict(
      "fail",
      "fund",
      `No Hedera account exists at ${recipient}. Send it some HBAR first: that creates it.`,
    );
  }
  if (isLongZeroAddress(recipient) && !isLongZeroAddress(account.evmAddress)) {
    return verdict(
      "fail",
      "none",
      `${recipient} is the long-zero form of ${account.accountId}, which has its own EVM address ${account.evmAddress}. ` +
        "Pass that address: the network refuses the long-zero form of such an account (INVALID_ALIAS_KEY).",
    );
  }
  if (relationship !== null) {
    return verdict("pass", "none", `${account.accountId} is already associated with ${token.symbol}.`);
  }
  const slots = account.maxAutomaticTokenAssociations;
  if (slots === -1) {
    return verdict(
      "pass",
      "none",
      `${account.accountId} has unlimited automatic associations: its first ${token.symbol} associates it inside ` +
        "the swap, with no separate association transaction to send.",
      true,
    );
  }
  if (slots === 0) {
    return verdict(
      "fail",
      "associate",
      `${account.accountId} is not associated with ${token.symbol} and has no automatic association slot, so the ` +
        `swap would revert and still charge the gas. Associate ${token.symbol} from that account first.`,
    );
  }
  return verdict(
    "warn",
    "associate",
    `${account.accountId} is not associated with ${token.symbol} and has ${slots} automatic association slots, and ` +
      "the mirror node does not say how many are in use. If none is free, the swap reverts " +
      "(NO_REMAINING_AUTOMATIC_ASSOCIATIONS) and still charges the gas.",
    true,
  );
}

export async function checkRecipient(
  mirror: MirrorClient,
  { recipient, token }: { recipient: EvmAddress; token: TokenEntry },
): Promise<RecipientVerdict> {
  const account = await mirror.getAccount(recipient);
  const relationship = account === null ? null : await mirror.getTokenRelationship(account.accountId, token.id);
  return recipientVerdict(recipient, account, relationship, token);
}

/**
 * An HTS function that answers with a response code (associate(), for one) does not revert when it fails: the
 * transaction succeeds, is charged, and returns the code. Anything but 22 means the operation did not happen.
 */
export function facadeResultVerdict(responseCode: bigint): PreflightVerdict {
  const code = Number(responseCode);
  if (code === SUCCESS_CODE) {
    return { check: "facade-result", status: "pass", action: "none", message: "The HTS operation succeeded (22)." };
  }
  const failure = explainResponseCode(code, "HTS function return value");
  return {
    check: "facade-result",
    status: "fail",
    action: failure.action,
    message: `The transaction succeeded but the HTS operation returned ${code}${failure.statusName ? ` (${failure.statusName})` : ""}. ${failure.message}`,
  };
}

/**
 * An upper bound of the fee, always said as "up to": the gas is an estimate for this sender and these arguments, or
 * the limit of a gas rule when no simulator prices the call, and the network charges the gas the call really uses.
 * The estimate includes an automatic association when the swap makes one, which is why it is never a constant.
 */
export function costVerdict({
  gas,
  gasPrice,
  autoAssociates,
  token,
  hbarOut,
  source = "estimate",
}: {
  gas: bigint;
  /** eth_gasPrice, in weibar per gas. */
  gasPrice: bigint;
  autoAssociates: boolean;
  token: TokenEntry;
  /** The quoted HBAR output of a token → HBAR swap, to warn when the fee is larger. */
  hbarOut?: Tinybar;
  source?: CostSource;
}): CostVerdict {
  const fee = feeForGas(gas, gasPrice);
  const association = autoAssociates ? `, including the recipient's one-time association with ${token.symbol}` : "";
  const limit = source === "gas-rule" ? ", the gas limit this template supplies for a call no simulator prices" : "";
  const message = `Network fee: up to ${formatHbar(fee)}${association}${limit}.`;
  const verdict = { check: "cost" as const, action: "none" as const, gas, fee, source, walletNote: WALLET_FEE_NOTE };
  if (hbarOut !== undefined && fee >= hbarOut) {
    return {
      ...verdict,
      status: "warn",
      message: `${message} The swap returns ${formatHbar(hbarOut)}, less than that fee.`,
    };
  }
  return { ...verdict, status: "pass", message };
}

/**
 * The preview for a built call. A call named by a gas rule is never estimated: the relay refuses to price it, and
 * the rule's limit is what the transaction will carry.
 */
export async function checkCost(
  client: PublicClient,
  {
    call,
    account,
    autoAssociates,
    token,
    hbarOut,
    functions,
  }: {
    call: BuiltCall;
    account: EvmAddress;
    autoAssociates: boolean;
    token: TokenEntry;
    hbarOut?: Tinybar;
    /** The functions the call runs, the inner ones of a multicall included; its own by default. */
    functions?: readonly string[];
  },
): Promise<CostVerdict> {
  const rule = gasRuleFor(call.address, functions ?? [call.functionName]);
  const [gas, gasPrice] = await Promise.all([
    rule === null ? client.estimateContractGas({ ...call, account }) : Promise.resolve(rule.gasLimit),
    client.getGasPrice(),
  ]);
  return costVerdict({
    gas,
    gasPrice,
    autoAssociates,
    token,
    hbarOut,
    source: rule === null ? "estimate" : "gas-rule",
  });
}
