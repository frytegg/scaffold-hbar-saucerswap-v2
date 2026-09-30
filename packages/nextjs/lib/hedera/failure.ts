import { swapRevertAbi } from "./abi";
import type { EvmAddress } from "./evmAddress";
import { GAS_RULES_MODULE, GasRuleError, gasRuleFor } from "./gasRules";
import { type MirrorClient, type MirrorContractAction, type MirrorContractResult, MirrorError } from "./mirror";
import { type StatusName, failureStatusIn, statusNameOf } from "./responseCodes";
import { extractRpcError } from "./rpcError";
import { SwapBuildError } from "./swap";
import { type Tinybar, UnitError, type Weibar, valueShortfall } from "./units";
import { type DecodeErrorResultReturnType, type Hex, decodeErrorResult, isHex } from "viem";

/** What the person in front of the app can do about a failure. */
export type FailureAction =
  | "associate"
  | "approve"
  | "fund"
  | "scale-value"
  | "requote"
  | "retry"
  | "supply-gas"
  | "none";

export type FailureKind =
  /** Refused by this library before any request: a unit mistake, a zero minimum, an out-of-range amount. */
  | "refused-before-sending"
  /** Refused by the JSON-RPC relay's own checks before the transaction reached the network. */
  | "relay-precheck"
  /** An HBAR value passed in tinybar where weibar was due, reported by the network as a token balance problem. */
  | "unscaled-value"
  /** A SaucerSwap custom error carrying a Hedera response code. */
  | "hts-response-code"
  /** The revert data was empty; the status name survived only in the relay's message. */
  | "hedera-status-text"
  /** Neither simulator will price this call, so no wallet can send it without a gas limit from the dapp. */
  | "not-estimable"
  | "revert-string"
  | "empty-revert"
  | "unknown-revert"
  | "rpc-refusal"
  /** The wallet itself refused, with an EIP-1193 provider code. The relay never saw the request. */
  | "wallet-unsupported"
  | "rate-limited"
  | "unavailable"
  | "rejected-by-user"
  | "unknown";

export type HederaFailure = {
  kind: FailureKind;
  /** The Hedera response code when one is known (for example 292), otherwise the JSON-RPC error code, or null. */
  code: number | null;
  statusName: StatusName | null;
  /** A sentence for the user. It never repeats viem's `shortMessage`, which says "HTTP request failed." on 2.39.0. */
  message: string;
  action: FailureAction;
  /** Where the explanation came from, for logs and bug reports. */
  via: string;
};

/**
 * What the caller knows about the call that failed. Every field is optional, and each one buys one answer the error
 * alone does not carry: `value` with `amountIn` turns a misleading INSUFFICIENT_TOKEN_BALANCE into the unit mistake
 * it is, and `address` with `functions` says whether a gas rule covers the call, which is the difference between
 * "no simulator prices this" and a refusal that named no cause at all.
 */
export type FailureContext = {
  value?: Weibar;
  amountIn?: Tinybar;
  address?: EvmAddress;
  /** The functions the call runs, the inner ones of a multicall included, as `withGasLimit` takes them. */
  functions?: readonly string[];
};

type Advice = { action: FailureAction; message: string };

const STATUS_ADVICE: Record<Exclude<StatusName, "SUCCESS" | "CONTRACT_REVERT_EXECUTED">, Advice> = {
  INSUFFICIENT_TOKEN_BALANCE: {
    action: "fund",
    message: "The sender does not hold enough of the input token for this swap.",
  },
  TOKEN_NOT_ASSOCIATED_TO_ACCOUNT: {
    action: "associate",
    message:
      "The recipient is not associated with the token it would receive and has no free automatic association " +
      "slot. Associate the token from the recipient's account first.",
  },
  TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT: {
    action: "none",
    message: "The account was already associated with this token: nothing changed, and the call was still charged.",
  },
  NO_REMAINING_AUTOMATIC_ASSOCIATIONS: {
    action: "associate",
    message:
      "The recipient has no automatic association slot left. Associate the token from the recipient's account first.",
  },
  // This is what 226 means wherever the call is not one of gasRules.ts's: on the network, and at simulation for any
  // other call. For a call a rule names, explainError reads the same answer as "no simulator prices this" instead.
  INVALID_NFT_ID: {
    action: "none",
    message: "The network answered INVALID_NFT_ID: the position NFT this call names does not exist.",
  },
  INVALID_ALIAS_KEY: {
    action: "none",
    message:
      "The recipient was given in long-zero form (0x000…) although the account has an EVM address of its own. " +
      "Pass the account's evm_address from the mirror node.",
  },
  SPENDER_DOES_NOT_HAVE_ALLOWANCE: {
    action: "approve",
    message: "The SaucerSwap router has no allowance to spend this token for the sender. Approve the amount first.",
  },
  AMOUNT_EXCEEDS_ALLOWANCE: {
    action: "approve",
    message: "The SaucerSwap router's allowance is smaller than the amount. Approve at least the amount first.",
  },
};

/** The revert strings the router raises on the two swap paths. */
const REVERT_STRINGS = new Map([
  [
    "Too little received",
    "The swap would return less than the minimum you accepted: the price moved. Get a new quote.",
  ],
  ["Transaction too old", "The deadline passed before the swap executed. Get a new quote and send it again."],
]);

const NOT_ESTIMABLE_MESSAGE =
  "This call cannot be estimated on Hedera; the dapp must supply a gas limit, because a wallet that cannot price a " +
  `call will not send it. The limits this template supplies, and where each number comes from, are in ${GAS_RULES_MODULE}.`;

// What MetaMask 13.48.0 (Chrome 152, Hedera testnet, 22 Sept 2026) wrapped the relay's refusal in when it could not
// price a position mint: it displayed no fee at all and the send failed. The sentence names no cause, and this relay
// answers every JSON-RPC error with HTTP 400, so it stands for a nonce, a balance or a rate limit just as well: only
// a gas rule covering the call says which of them it was.
const WALLET_REFUSED = /RPC endpoint returned HTTP client error/i;
const SENDING_METHOD = /eth_(?:sendRawTransaction|sendTransaction|estimateGas)\b/;
const WALLET_REFUSED_MESSAGE =
  "The wallet's JSON-RPC endpoint refused the request with an HTTP error and gave no reason: this relay answers " +
  "every JSON-RPC error that way, so the cause is not in the message. Check the sender's HBAR balance, and read the " +
  "transaction on the mirror node if the wallet returned a hash.";

const EMPTY_REVERT_SIMULATED =
  "The call reverted without data. SaucerSwap's multicall drops its custom errors, which are too short to pass " +
  "through: simulate the inner exactInput call directly to read the reason.";
const EMPTY_REVERT_SENT =
  "The transaction reverted without data: SaucerSwap's multicall drops its custom errors. The inner revert is in the " +
  "mirror node's /api/v1/contracts/results/{hash}/actions view, which postMortem reads.";

function fromStatus(code: number, kind: FailureKind, via: string): HederaFailure {
  const statusName = statusNameOf(code);
  const advice =
    statusName !== null && statusName in STATUS_ADVICE ? STATUS_ADVICE[statusName as keyof typeof STATUS_ADVICE] : null;
  return {
    kind,
    code,
    statusName,
    message: advice?.message ?? `Hedera answered response code ${code}${statusName ? ` (${statusName})` : ""}.`,
    action: advice?.action ?? "none",
    via,
  };
}

/** A Hedera response code met outside a revert: returned by an HTS function inside a successful transaction. */
export function explainResponseCode(code: number, via: string): HederaFailure {
  return fromStatus(code, "hts-response-code", via);
}

function decodeRevert(data: Hex): DecodeErrorResultReturnType<typeof swapRevertAbi> | null {
  try {
    return decodeErrorResult({ abi: swapRevertAbi, data });
  } catch {
    // A selector outside this ABI and outside Error(string) / Panic(uint256): the caller reports it by selector.
    return null;
  }
}

/** Reads revert data, falling back to the status name in the relay's message when the data is empty. */
function explainRevert(data: Hex, relayText: string | null, emptyMessage: string, via: string): HederaFailure {
  if (data !== "0x") {
    const decoded = decodeRevert(data);
    if (decoded?.errorName === "RespCode" || decoded?.errorName === "TransferFail") {
      const code = Number(decoded.args[0]);
      return fromStatus(code, "hts-response-code", `${via}: ${decoded.errorName}(${code})`);
    }
    if (decoded?.errorName === "Error") {
      const reason = decoded.args[0];
      const known = REVERT_STRINGS.get(reason);
      return {
        kind: "revert-string",
        code: null,
        statusName: null,
        message: known ?? `The contract refused the call: "${reason}".`,
        action: known === undefined ? "none" : "requote",
        via: `${via}: Error("${reason}")`,
      };
    }
    return {
      kind: "unknown-revert",
      code: null,
      statusName: null,
      message: `The contract reverted with an error this app does not know (selector ${data.slice(0, 10)}).`,
      action: "none",
      via,
    };
  }
  const status = relayText === null ? null : failureStatusIn(relayText);
  if (status !== null) return fromStatus(status.code, "hedera-status-text", `${via}: status name in the relay message`);
  return { kind: "empty-revert", code: null, statusName: null, message: emptyMessage, action: "none", via };
}

function fromLibraryError(error: UnitError | SwapBuildError | GasRuleError): HederaFailure {
  const scalesValue = error instanceof UnitError && error.code.startsWith("value-");
  const suppliesGas = error instanceof GasRuleError;
  return {
    kind: "refused-before-sending",
    code: null,
    statusName: null,
    message: error.message,
    action: scalesValue ? "scale-value" : suppliesGas ? "supply-gas" : "none",
    via: `${error.name} ${error.code}`,
  };
}

/** A call neither simulator prices. Both the wallet's refusal and the simulators' own answer arrive here. */
function notEstimable(code: number | null, statusName: StatusName | null, via: string): HederaFailure {
  return { kind: "not-estimable", code, statusName, message: NOT_ESTIMABLE_MESSAGE, action: "supply-gas", via };
}

/**
 * Whether a gas rule covers the call the caller named. Told nothing about the call, the answer is no: advising a gas
 * limit for a call that has no rule sends a transaction the network refuses, and it is charged for it.
 */
function ruleCovers(context: FailureContext | undefined): boolean {
  if (context?.address === undefined || context.functions === undefined) return false;
  return gasRuleFor(context.address, context.functions) !== null;
}

/** The error's own text, for the shapes a browser wallet wraps a refusal in and gives no JSON-RPC code. */
function textOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return "";
  const { message } = error as { message?: unknown };
  return typeof message === "string" ? message : "";
}

/**
 * Explains a failed request, simulation or send. Pass what is known about the call: without `value` and `amountIn`
 * an unscaled value reads as INSUFFICIENT_TOKEN_BALANCE and the advice would be to fund the account, and without
 * `address` and `functions` a refusal that names no cause is reported as that, never as a missing gas limit.
 */
export function explainError(error: unknown, context?: FailureContext): HederaFailure {
  if (error instanceof UnitError || error instanceof SwapBuildError || error instanceof GasRuleError) {
    return fromLibraryError(error);
  }
  if (error instanceof MirrorError) {
    const transient = error.reason === "unavailable" || error.reason === "timeout";
    return {
      kind: transient ? "unavailable" : "unknown",
      code: error.status,
      statusName: null,
      message: error.message,
      action: transient ? "retry" : "none",
      via: `MirrorError ${error.reason}`,
    };
  }

  const rpc = extractRpcError(error);
  const relayMessage = rpc.message ?? "";
  const walletText = `${relayMessage}\n${textOf(error)}`;

  if (rpc.code === -32602 && relayMessage.includes("less than 10_000_000_000 wei")) {
    return {
      kind: "relay-precheck",
      code: -32602,
      statusName: null,
      message: `The JSON-RPC relay refused the transaction: "${relayMessage}". Transaction values are weibar: pass tinybar × 10^10.`,
      action: "scale-value",
      via: "relay precheck -32602 at eth_sendRawTransaction",
    };
  }

  // A wallet that refused a send: it has no revert data to show, only its own wrapper, which names no cause. It is
  // the wallet failing to price the call when a rule says the call is one the network will not price, and an
  // unexplained HTTP error otherwise — a nonce, an empty account, a rate limit, all of them wear this same sentence.
  if (rpc.data === null && WALLET_REFUSED.test(walletText) && SENDING_METHOD.test(walletText)) {
    return ruleCovers(context)
      ? notEstimable(rpc.code, null, "the wallet could not price the call and refused to send it")
      : failureOf("rpc-refusal", rpc.code, WALLET_REFUSED_MESSAGE, "none", "the wallet's RPC endpoint, HTTP error");
  }

  if (rpc.code === 3 || rpc.data !== null) {
    const failure = explainRevert(rpc.data ?? "0x", rpc.message, EMPTY_REVERT_SIMULATED, "revert");
    // Both simulators refuse a position mint with this status although the network executes it: for the calls a gas
    // rule names, it is the answer of a call that cannot be priced. For every other call, and for a transaction that
    // reached the network, 226 means what it says — the NFT does not exist — and asking for a gas limit there would
    // send a transaction the network refuses and charges for.
    if (failure.statusName === "INVALID_NFT_ID" && ruleCovers(context)) {
      return notEstimable(failure.code, failure.statusName, `${failure.via}, refused at simulation`);
    }
    const shortfall =
      context?.value === undefined || context.amountIn === undefined
        ? null
        : valueShortfall(context.value, context.amountIn);
    if (failure.statusName === "INSUFFICIENT_TOKEN_BALANCE" && shortfall !== null) {
      return { ...failure, kind: "unscaled-value", message: shortfall.message, action: "scale-value" };
    }
    return failure;
  }

  if (rpc.code === 4001) {
    return failureOf("rejected-by-user", 4001, "The request was rejected in the wallet.", "none", "EIP-1193 4001");
  }
  if (rpc.code === -32005 || rpc.httpStatus === 429) {
    return failureOf(
      "rate-limited",
      rpc.code,
      "The JSON-RPC relay is rate limiting requests. Retry in a few seconds.",
      "retry",
      "rate limit",
    );
  }
  if (rpc.code === -32002 || rpc.noAnswer || (rpc.httpStatus !== null && rpc.httpStatus >= 500)) {
    return failureOf(
      "unavailable",
      rpc.code,
      "The JSON-RPC relay did not answer. Retry in a moment.",
      "retry",
      "no answer",
    );
  }
  if (rpc.code === -32004) {
    return failureOf(
      "rpc-refusal",
      -32004,
      "One eth_getLogs query may span at most 7 days on this relay: narrow the window, or read the history from the mirror node.",
      "none",
      `relay -32004: ${relayMessage}`,
    );
  }
  // EIP-1193 numbers provider errors in the 4000s, and a provider is the wallet. Calling one of these a relay
  // refusal names the wrong culprit, which is the mistake this whole library exists to stop. Measured on
  // 30 September 2026: HashPack over WalletConnect answers 4200 to `eth_sendTransaction`, viem retries with
  // `wallet_sendTransaction` and is refused again, and the network had already executed the call.
  if (rpc.code !== null && rpc.code >= 4000 && rpc.code <= 4999) {
    return failureOf(
      "wallet-unsupported",
      rpc.code,
      rpc.code === 4200
        ? `The wallet does not support the method this send needs: ${relayMessage}. The relay never saw the ` +
            `request. The wallet may still have executed the transaction: read the account on the mirror node ` +
            `before sending it again.`
        : `The wallet refused the request: ${relayMessage}. The relay never saw it.`,
      "none",
      `EIP-1193 ${rpc.code}`,
    );
  }

  if (rpc.code !== null) {
    return failureOf(
      "rpc-refusal",
      rpc.code,
      `The JSON-RPC relay refused the request: ${relayMessage}`,
      "none",
      `relay ${rpc.code}`,
    );
  }
  const text = error instanceof Error ? error.message.split("\n")[0] : String(error);
  return failureOf("unknown", null, text, "none", error instanceof Error ? error.name : typeof error);
}

function failureOf(
  kind: FailureKind,
  code: number | null,
  message: string,
  action: FailureAction,
  via: string,
): HederaFailure {
  return { kind, code, statusName: null, message, action, via };
}

function innermostRevert(actions: readonly MirrorContractAction[]): MirrorContractAction | null {
  return actions.reduce<MirrorContractAction | null>((deepest, action) => {
    const reverted =
      action.resultDataType === "REVERT_REASON" && action.resultData !== null && action.resultData !== "0x";
    return reverted && (deepest === null || action.callDepth > deepest.callDepth) ? action : deepest;
  }, null);
}

/**
 * Explains a transaction that reached the network, from its mirror DETAIL view; null when it succeeded. When a
 * multicall erased the revert data, pass the transaction's actions: the inner revert survives there.
 */
export function explainContractResult(
  result: MirrorContractResult,
  actions: readonly MirrorContractAction[] = [],
): HederaFailure | null {
  if (result.result === "SUCCESS") return null;
  const { errorMessage } = result;
  if (errorMessage !== null && isHex(errorMessage) && errorMessage !== "0x") {
    return explainRevert(errorMessage, null, EMPTY_REVERT_SENT, "mirror error_message");
  }
  const inner = innermostRevert(actions);
  if (inner?.resultData) {
    return explainRevert(inner.resultData, null, EMPTY_REVERT_SENT, `mirror actions, call depth ${inner.callDepth}`);
  }
  const status = failureStatusIn(`${result.result} ${errorMessage ?? ""}`);
  if (status !== null) return fromStatus(status.code, "hedera-status-text", "mirror result");
  if (result.result === "CONTRACT_REVERT_EXECUTED") {
    return failureOf("empty-revert", null, EMPTY_REVERT_SENT, "none", "mirror error_message");
  }
  return failureOf("unknown", null, `The network answered ${result.result}.`, "none", "mirror result");
}

/** After a send: reads the actions only when the revert data is empty, then explains the result. Null on success. */
export async function postMortem(mirror: MirrorClient, result: MirrorContractResult): Promise<HederaFailure | null> {
  if (result.result === "SUCCESS") return null;
  const needsActions = result.errorMessage === null || result.errorMessage === "0x";
  return explainContractResult(result, needsActions ? await mirror.getContractActions(result.hash) : []);
}
