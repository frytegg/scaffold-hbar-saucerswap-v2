# Use the checks in your app

Each of these answers one question a Hedera transaction fails on, before anything is signed. Can the recipient receive the token? May the router spend it? Can the call be priced at all? The network charges for these failures and refuses the transaction anyway. The allowance is the one every simulator a wallet can ask accepts. In that case the wallet showed a fee, a Confirm button and no warning of any kind. The transaction failed on the network afterwards. This template's pages are one caller of these functions; your app can be another.

Every function below is exported by `packages/nextjs/lib/hedera/index.ts` and imported from `~~/lib/hedera`. The reads are keyless: an account, a token relation, an allowance, an NFT approval, a gas price.

To call them from a project of your own, copy the modules at the top of `packages/nextjs/lib/hedera/` into it. Its two subdirectories are this repository's own test and script tiers, and nothing you call is in them. Then point one of your own path aliases at where you put them. Or replace `~~/lib/hedera` in the example below with that path. `~~` is this template's own alias. It resolves to nothing outside a Scaffold-HBAR project. There is no package to install; copying is how you take it.

Nothing else has to come with them. Each of those modules imports from that same directory and from `viem`, and from nothing else. No Next.js, no React, no wagmi, no page, hook or component of this template. `packages/nextjs/lib/hedera/__tests__/libraryDependencies.test.ts` reads them and fails on any import that is neither. That rule is checked, not remembered. At run time they need the two public endpoints the example names, and no key.

That copy was made on 24 September 2026, into a project holding nothing but `viem` and TypeScript. The modules
compiled under `strict`, and a `checkRecipient` in that project answered from the mirror node. It needed two
things, neither of them this template's. First, `skipLibCheck` or the DOM library in its `tsconfig.json`, because
viem's own dependency declares browser types. Second, a bundler or CommonJS output, because these modules import
each other without file extensions, and Node refuses that when it reads them as ES modules. A Scaffold-HBAR or
Next.js project gives both already.

```ts
import { createPublicClient, http } from "viem";
import {
  type BuiltCall,
  type EvmAddress,
  checkAllowance,
  checkRecipient,
  createMirrorClient,
  directMirrorTransport,
  explainError,
  gasRuleFor,
  testnet,
  withGasLimit,
} from "~~/lib/hedera";

const rpc = createPublicClient({ transport: http("https://testnet.hashio.io/api") });
const mirror = createMirrorClient({ transport: directMirrorTransport("https://testnet.mirrornode.hedera.com") });

export async function beforeSending(call: BuiltCall, owner: EvmAddress, amountIn: bigint, functions: string[]) {
  try {
    const verdicts = [
      await checkRecipient(mirror, { recipient: owner, token: testnet.sauce }),
      await checkAllowance(rpc, { token: testnet.sauce, owner, amountIn }),
    ];
    const gas = gasRuleFor(call.address, functions)?.gasLimit;
    return { verdicts, call: withGasLimit(call, { functions, gas }), failure: null };
  } catch (error: unknown) {
    return { verdicts: [], call: null, failure: explainError(error, { address: call.address, functions }) };
  }
}
```

`rpc` is a viem `PublicClient` and `mirror` a `MirrorClient` over the public endpoints. Every verdict carries `check`, `status` (`pass`, `warn` or `fail`), `message` and `action`. `explainError` returns `kind`, `code`, `statusName`, `message` and `action`. Below, `{…}` is what the call fills in.

| behaviour | exported from `~~/lib/hedera` | the call | what it answers |
| --- | --- | --- | --- |
| the simulators approve a swap the network refuses | `checkAllowance`, or `allowanceVerdict` for an allowance already read | `await checkAllowance(rpc, { token: testnet.sauce, owner, amountIn })` | `fail`, action `approve` — The SaucerSwap router has no allowance to spend your {symbol}. Approve {amountIn} first: without it the network rejects the swap and still charges the gas. |
| some calls cannot be priced, and the wallet then cannot send them | `gasRuleFor`, `withGasLimit` | `withGasLimit(call, { functions, gas: gasRuleFor(call.address, functions)?.gasLimit })` | the same call carrying the rule's limit. Called without one, it throws `GasRuleError`, action `supply-gas` — {functions} on {contract} cannot be estimated on Hedera: eth_call and eth_estimateGas answered "CONTRACT_REVERT_EXECUTED, INVALID_NFT_ID" on 2026-09-22 (relay/0.78.5), and a wallet that cannot price a call will not send it. Pass gas: this template sends {gasLimit}, above the {gasUsed} gas the same call used in the executions the rule lists. See packages/nextjs/lib/hedera/gasRules.ts. |
| the wallet prices the gas limit; the network charges the gas used | `checkCost`, `WALLET_FEE_NOTE` | `await checkCost(rpc, { call, account, autoAssociates, token, functions })` | `pass` — Network fee: up to {fee}, the gas limit this template supplies for a call no simulator prices. And on `walletNote` — Your wallet announces about the same figure, because it prices the gas limit at the current gas price. The network charges only the gas the call uses, so what leaves the account is smaller on every transaction this project has measured. |
| emptying a position pays a wrapped token, unless the call is split in three | `buildSplitCollect` | `buildSplitCollect({ tokenId, recipient, hbarMinimum })` | one `multicall` of the three calls, in the order that paid native HBAR. With a floor of zero and no `acceptAnyAmount`, it throws `PositionBuildError` — This collect puts no floor on the HBAR it unwraps, and unwrapWHBAR sends whatever the manager holds: with a floor of zero, a collect that pulled nothing still succeeds and is charged its whole gas. Pass what the position is owed on the HBAR side, a tolerance under it, or acceptAnyAmount: true. |
| a burn the simulators accept, and the network refuses | `checkPositionBurn`, `buildBurn` | `await checkPositionBurn(rpc, owner)` | `fail`, action `approve` — The position manager is not approved on SSV2-LP, and a burn moves the position NFT back to it. Send setApprovalForAll first: simulation accepts the burn either way and the network answers HederaFail(292) after charging the gas. |
| HBAR has two units, and the wrong one fails under another name | `payable`, `hbarToTinybar` | `payable(hbarToTinybar("0.1"), amountIn)` | `{ value }`, the amount in weibar, which is the only way to a transaction value outside the library. Below the amount the call spends, it throws `UnitError`, action `scale-value` — The transaction value, {value} weibar ({value} HBAR), does not cover amountIn, {amountIn} tinybar ({amountIn} HBAR). Transaction values are weibar: pass amountIn × 10^10. |
| a token cannot reach an account that has never held it | `checkRecipient`, or `recipientVerdict` for an account already read | `await checkRecipient(mirror, { recipient, token: testnet.sauce })` | one of six verdicts. Without a relation and without a free slot, `fail`, action `associate` — {account} is not associated with {symbol} and has no automatic association slot, so the swap would revert and still charge the gas. Associate {symbol} from that account first. |
| an account can have two addresses, and only one of them can receive a token | `checkRecipient`, `isLongZeroAddress` | the same call, which compares the two forms before it looks at associations | `fail` — {recipient} is the long-zero form of {account}, which has its own EVM address {evmAddress}. Pass that address: the network refuses the long-zero form of such an account (INVALID_ALIAS_KEY). |
| a failed HTS operation can be a successful transaction | `facadeResultVerdict`, `explainResponseCode` | `facadeResultVerdict(responseCode)` | on anything but 22, `fail` — The transaction succeeded but the HTS operation returned 194 (TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT). The account was already associated with this token: nothing changed, and the call was still charged. |

After a send, `postMortem(mirror, result)` reads the transaction's DETAIL view, and its `/actions` when a `multicall` left `0x` behind. It answers the same shape as `explainError`.

[`hedera-behaviour.md`](hedera-behaviour.md) holds the transactions each sentence comes from, what the mistake costs in HBAR and the test that pins the sentence. It has one section per row, in the order of the table above. `yarn check:docs` holds that order: it reads those rows against that file's own headings. The nine sentences are quoted from the functions that say them. `packages/nextjs/lib/hedera/__tests__/docSentences.test.ts` asserts each one against its own function, so a message reworded in the library fails `yarn test:unit` instead of leaving this page quietly wrong. `yarn replay` prints three of them with nothing else running: no key, no wallet, no account, no network.
