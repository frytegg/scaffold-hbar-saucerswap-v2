import { testnet } from "./addresses";
import type { EvmAddress } from "./evmAddress";
import type { BuiltCall } from "./swap";

// Some calls cannot be priced on Hedera: eth_call and eth_estimateGas refuse them although the network executes
// them. A wallet asks the relay for the same estimate, so with none it shows no fee and will not send the call.
// The dapp has to carry the gas limit itself, and this is where every such limit comes from.

/** One execution of a call of this shape, read back from the mirror node. */
export type GasMeasurement = {
  readonly gasUsed: bigint;
  readonly hash: `0x${string}`;
  readonly mirrorUrl: string;
  /** UTC date of the transaction, and what sent it. */
  readonly sentOn: string;
  readonly sentBy: string;
};

export type GasRule = {
  readonly contract: EvmAddress;
  /** The functions this rule covers: a call runs its own, plus the inner ones when it is a multicall. */
  readonly functions: readonly string[];
  /** What both simulators answer instead of a price, on the relay and the date below. */
  readonly simulatorAnswer: string;
  readonly observedOn: string;
  readonly relayVersion: string;
  /** The gas limit this template sends the call with. */
  readonly gasLimit: bigint;
  /** What the same call really used, which is where the limit comes from. */
  readonly measurements: readonly GasMeasurement[];
};

/** Where a reader finds these rules. The decoder puts it in the message of a call it could not price. */
export const GAS_RULES_MODULE = "packages/nextjs/lib/hedera/gasRules.ts";

const MIRROR_RESULT = "https://testnet.mirrornode.hedera.com/api/v1/contracts/results";

/**
 * A round million, which leaves every execution below about a third of itself in room. The margin is that wide
 * because no estimate exists to size it from, and that tight because a wallet displays the limit at the current gas
 * price: the 2,500,000 of the one execution below that a wallet sent made MetaMask announce 2.85 HBAR for a call
 * that cost 0.82781031. `largestMeasuredGas` is what the refusal message quotes, so the room left is read from the list
 * rather than from this comment. Unused gas was not charged on any transaction this project has sent, which is a
 * dated observation of Hedera testnet, not a rule of the network.
 */
const POSITION_MINT_GAS_LIMIT = 1_000_000n;

export const gasRules: readonly GasRule[] = [
  {
    contract: testnet.positionManager.evmAddress,
    functions: ["mint"],
    simulatorAnswer: "CONTRACT_REVERT_EXECUTED, INVALID_NFT_ID",
    observedOn: "2026-09-22",
    relayVersion: "relay/0.78.5",
    gasLimit: POSITION_MINT_GAS_LIMIT,
    measurements: [
      {
        gasUsed: 761_459n,
        hash: "0xa35920e369373313f7510d9e01d79d3814fa4f4d158aa01de72decefc4ac7b0b",
        mirrorUrl: `${MIRROR_RESULT}/0xa35920e369373313f7510d9e01d79d3814fa4f4d158aa01de72decefc4ac7b0b`,
        sentOn: "2026-09-21",
        sentBy: "a viem script, gas limit 2,500,000",
      },
      {
        gasUsed: 759_459n,
        hash: "0x87a4940c26dba471e1c73b19520bbc38d78cfbf015fbb523de5635d6c12a937e",
        mirrorUrl: `${MIRROR_RESULT}/0x87a4940c26dba471e1c73b19520bbc38d78cfbf015fbb523de5635d6c12a937e`,
        sentOn: "2026-09-22",
        sentBy: "MetaMask 13.48.0, gas limit 2,500,000 supplied by the page",
      },
      {
        gasUsed: 761_531n,
        hash: "0xac5b06097841d492cad222545bd01eddc837099040bd1d5e5bb3abfd1e85d017",
        mirrorUrl: `${MIRROR_RESULT}/0xac5b06097841d492cad222545bd01eddc837099040bd1d5e5bb3abfd1e85d017`,
        sentOn: "2026-09-23",
        sentBy: "this template's own evidence:position command, gas limit 1,000,000",
      },
    ],
  },
];

// Checked on 22 Sept 2026 against the same position manager (relay/0.78.5, keyless, nothing signed) and deliberately
// left out of the list above:
// - increaseLiquidity is priced: both simulators reach the contract's own checks, answering MF with no value and
//   TOKEN_NOT_ASSOCIATED_TO_ACCOUNT once the value covers the mint fee, which SaucerSwap charges again there.
// - decreaseLiquidity, collect and burn were priced by the browser wallet itself during the session of 22 Sept: the
//   gas limits the mirror node shows for them (203,994, 943,608 and 85,207) are the relay's own estimates, against
//   169,995, 888,485 and 77,921 used. Simulating them from an account that does not own the position answers "not
//   authorized", so re-checking them keylessly needs a position this project owns.

export type GasRuleErrorCode = "missing-gas-limit";

export class GasRuleError extends Error {
  readonly code: GasRuleErrorCode;
  readonly rule: GasRule;

  constructor(code: GasRuleErrorCode, message: string, rule: GasRule) {
    super(message);
    this.name = "GasRuleError";
    this.code = code;
    this.rule = rule;
  }
}

function sameAddress(left: EvmAddress, right: EvmAddress): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * The rule for a call to `contract` that runs `functions`, or null when the network prices the call itself.
 * Pass the inner function names of a multicall: `multicall[mint, refundETH]` is refused for its mint.
 */
export function gasRuleFor(contract: EvmAddress, functions: readonly string[]): GasRule | null {
  return (
    gasRules.find(
      rule => sameAddress(rule.contract, contract) && functions.some(name => rule.functions.includes(name)),
    ) ?? null
  );
}

/** The largest gas any execution of this call has used, which is what the limit leaves room above. */
export function largestMeasuredGas(rule: GasRule): bigint {
  return rule.measurements.reduce(
    (largest, measurement) => (measurement.gasUsed > largest ? measurement.gasUsed : largest),
    0n,
  );
}

/**
 * Adds a gas limit to a built call, and refuses a call the network will not price when the caller supplies none:
 * sending it would leave the wallet with no fee to show, and it would not send. `functions` are the functions the
 * call runs, the inner ones of a multicall included; a call the network prices is returned unchanged.
 */
export function withGasLimit<T extends BuiltCall>(
  call: T,
  options: { readonly functions?: readonly string[]; readonly gas?: bigint } = {},
): T & { readonly gas?: bigint } {
  const { functions = [call.functionName], gas } = options;
  const rule = gasRuleFor(call.address, functions);
  if (rule !== null && gas === undefined) {
    throw new GasRuleError(
      "missing-gas-limit",
      `${rule.functions.join(", ")} on ${rule.contract} cannot be estimated on Hedera: eth_call and eth_estimateGas ` +
        `answered "${rule.simulatorAnswer}" on ${rule.observedOn} (${rule.relayVersion}), and a wallet that cannot ` +
        `price a call will not send it. Pass gas: this template sends ${rule.gasLimit}, above the ` +
        `${largestMeasuredGas(rule)} gas the same call used in the executions the rule lists. See ${GAS_RULES_MODULE}.`,
      rule,
    );
  }
  return gas === undefined ? call : { ...call, gas };
}
