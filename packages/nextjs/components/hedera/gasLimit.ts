import { type BuiltCall, gasRuleFor, withGasLimit } from "~~/lib/hedera";

// The one door from a page to the gas rules. Every call a route builds goes through it, because a call neither
// eth_call nor eth_estimateGas will price has no fee for a wallet to show, and a wallet with no fee does not send:
// the dapp has to carry the limit. Asking the rules here is also what keeps a page from ever carrying a number of
// its own — a rule is added in lib/hedera/gasRules.ts, with the executions it comes from, and a route inherits it.

/**
 * The call, with the gas limit its rule names when one covers it, and untouched when the network prices it.
 * `functions` are the functions the call runs, the inner ones of a multicall included, because a rule names an
 * inner function and not the multicall it is wrapped in. An explicit `gas` wins over the rule's own limit.
 */
export function withRuleGasLimit<T extends BuiltCall>(
  call: T,
  options: { readonly functions?: readonly string[]; readonly gas?: bigint } = {},
): T & { readonly gas?: bigint } {
  const functions = options.functions ?? [call.functionName];
  const rule = gasRuleFor(call.address, functions);
  return withGasLimit(call, { functions, gas: options.gas ?? rule?.gasLimit });
}
