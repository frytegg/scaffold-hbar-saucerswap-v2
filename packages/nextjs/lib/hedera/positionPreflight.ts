import { type TokenEntry, testnet } from "./addresses";
import type { EvmAddress } from "./evmAddress";
import type { MirrorAccount, MirrorClient, MirrorTokenRelationship } from "./mirror";
import type { Minimums } from "./position";
import { readManagerAllowance, readNftApproval } from "./positionReads";
import type { PreflightVerdict } from "./preflight";
import { type Tinybar, WEIBAR_PER_TINYBAR, type Weibar, formatHbar, formatTokenAmount, tinybar } from "./units";
import type { PublicClient } from "viem";

// The checks a position needs on top of the swap's, each one for something a simulation lets through. Hedera checks
// allowances, associations and NFT approvals below the EVM, so `eth_call` and `eth_estimateGas` answer on the EVM
// logic alone and the network refuses afterwards, having charged the gas. "fail" blocks the send.

/**
 * The position manager, not the router, is what pulls the pool's token into a mint. An allowance granted to the
 * router does not cover it, and a short allowance is refused by the network as 292 or 293 after the gas is spent.
 */
export function managerAllowanceVerdict(allowance: bigint, amountIn: bigint, token: TokenEntry): PreflightVerdict {
  const needed = formatTokenAmount(amountIn, token);
  if (allowance >= amountIn) {
    return {
      check: "manager-allowance",
      status: "pass",
      action: "none",
      message: `The position manager may spend the ${needed} this position deposits.`,
    };
  }
  const current =
    allowance === 0n
      ? `The position manager has no allowance to spend your ${token.symbol}.`
      : `The position manager may spend only ${formatTokenAmount(allowance, token)}, less than the ${needed} this position deposits.`;
  return {
    check: "manager-allowance",
    status: "fail",
    action: "approve",
    message: `${current} Approve ${needed} to ${testnet.positionManager.evmAddress} first: without it the network rejects the mint and still charges the gas.`,
  };
}

/**
 * A position is an HTS NFT, so the account has to be able to receive one. An account with a free automatic slot is
 * associated inside the mint itself, which is part of why a mint costs the gas it does.
 */
export function lpNftSlotVerdict(
  account: MirrorAccount | null,
  relationship: MirrorTokenRelationship | null,
): PreflightVerdict {
  const verdict = (status: PreflightVerdict["status"], action: PreflightVerdict["action"], message: string) => ({
    check: "lp-nft-slot" as const,
    status,
    action,
    message,
  });
  if (account === null) {
    return verdict(
      "fail",
      "fund",
      "No Hedera account exists at this address. Send it some HBAR first: that creates it.",
    );
  }
  if (relationship !== null) {
    return verdict("pass", "none", `${account.accountId} already holds ${testnet.lpNft.symbol} positions.`);
  }
  const slots = account.maxAutomaticTokenAssociations;
  if (slots === 0) {
    return verdict(
      "fail",
      "associate",
      `${account.accountId} has no automatic association slot and no relation with ${testnet.lpNft.symbol} ` +
        `(${testnet.lpNft.id}), so the mint would revert and still charge the gas. Associate that token first.`,
    );
  }
  if (slots === -1) {
    return verdict(
      "pass",
      "none",
      `${account.accountId} has unlimited automatic associations: the mint associates ${testnet.lpNft.symbol} inside itself.`,
    );
  }
  return verdict(
    "warn",
    "associate",
    `${account.accountId} has ${slots} automatic association slots and no relation with ${testnet.lpNft.symbol}, ` +
      "and the mirror node does not say how many are in use. If none is free, the mint reverts and still charges the gas.",
  );
}

/** The approval a burn needs on the position NFT, which neither simulator checks. */
export function nftApprovalVerdict(approved: boolean): PreflightVerdict {
  if (approved) {
    return {
      check: "nft-approval",
      status: "pass",
      action: "none",
      message: `The position manager may move your ${testnet.lpNft.symbol} positions, which a burn needs.`,
    };
  }
  return {
    check: "nft-approval",
    status: "fail",
    action: "approve",
    message:
      `The position manager is not approved on ${testnet.lpNft.symbol}, and a burn moves the position NFT back ` +
      "to it. Send setApprovalForAll first: simulation accepts the burn either way and the network answers " +
      "HederaFail(292) after charging the gas.",
  };
}

/**
 * Whether the transaction carries enough for the HBAR the position deposits and the mint fee on top of it. The fee
 * is converted from tinycent again at execution, so a value that only just covers it is a mint that can fail on a
 * rate move; what the margin does not cover is returned by `refundETH` in the same transaction.
 */
export function mintValueVerdict(request: {
  readonly value: Weibar;
  readonly hbarAmount: Tinybar;
  readonly mintFeeTinybar: Tinybar;
}): PreflightVerdict {
  const { value, hbarAmount, mintFeeTinybar } = request;
  const carried = tinybar(value / WEIBAR_PER_TINYBAR);
  const needed = tinybar(hbarAmount + mintFeeTinybar);
  if (carried < needed) {
    return {
      check: "mint-value",
      status: "fail",
      action: "none",
      message:
        `The transaction carries ${formatHbar(carried)} for a position that deposits ${formatHbar(hbarAmount)} and ` +
        `a mint fee of ${formatHbar(mintFeeTinybar)}. Build the value with mintValue in lib/hedera/position.ts.`,
    };
  }
  if (carried === needed) {
    return {
      check: "mint-value",
      status: "warn",
      action: "none",
      message:
        `The transaction carries exactly the ${formatHbar(needed)} this mint needs, with nothing over for the fee's ` +
        "reconversion at execution. A rate move makes it fail.",
    };
  }
  return {
    check: "mint-value",
    status: "pass",
    action: "none",
    message: `The transaction carries ${formatHbar(carried)}: the deposit, the mint fee and ${formatHbar(tinybar(carried - needed))} of margin that refundETH returns.`,
  };
}

/** Whether the caller set a floor on what the position accepts, or said out loud that it accepts any price. */
export function minimumsVerdict(minimums: Minimums): PreflightVerdict {
  const { amount0Min, amount1Min, acceptAnyPrice = false } = minimums;
  if (amount0Min > 0n || amount1Min > 0n) {
    return {
      check: "minimums",
      status: "pass",
      action: "none",
      message: "The call refuses a price that would deposit less than the minimums it names.",
    };
  }
  if (acceptAnyPrice) {
    return {
      check: "minimums",
      status: "warn",
      action: "requote",
      message:
        "Both minimums are zero, so this call takes whatever price the pool is at when it reaches consensus. The " +
        "caller asked for that explicitly.",
    };
  }
  return {
    check: "minimums",
    status: "fail",
    action: "requote",
    message:
      "Both minimums are zero, so this call takes whatever price the pool is at when it reaches consensus. Set " +
      "them a slippage tolerance under what the range needs, or pass acceptAnyPrice.",
  };
}

export type PositionMintChecks = {
  readonly client: PublicClient;
  readonly mirror: MirrorClient;
  readonly owner: EvmAddress;
  readonly token: TokenEntry;
  readonly tokenAmount: bigint;
  readonly value: Weibar;
  readonly hbarAmount: Tinybar;
  readonly mintFeeTinybar: Tinybar;
  readonly minimums: Minimums;
};

/** Every check a mint needs, in the order a panel shows them. Reads only: nothing here signs or spends. */
export async function checkPositionMint(request: PositionMintChecks): Promise<PreflightVerdict[]> {
  const { client, mirror, owner, token, tokenAmount } = request;
  const account = await mirror.getAccount(owner);
  const [allowance, relationship] = await Promise.all([
    readManagerAllowance(client, token, owner),
    account === null ? Promise.resolve(null) : mirror.getTokenRelationship(account.accountId, testnet.lpNft.id),
  ]);
  return [
    managerAllowanceVerdict(allowance, tokenAmount, token),
    lpNftSlotVerdict(account, relationship),
    mintValueVerdict(request),
    minimumsVerdict(request.minimums),
  ];
}

/** The one check a burn needs, read from the NFT facade rather than from a simulation that cannot see it. */
export async function checkPositionBurn(client: PublicClient, owner: EvmAddress): Promise<PreflightVerdict> {
  return nftApprovalVerdict(await readNftApproval(client, owner));
}
