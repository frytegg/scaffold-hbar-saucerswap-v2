# Troubleshooting, by the string you were given

Paste what you got into your browser's find. Each entry says what the string means on Hedera, and the one thing to
do about it.

Every string below was captured from Hedera testnet, from its JSON-RPC relay or from a browser wallet by this
repository, and each entry names the file that holds it. None was written from memory, and the offline tests replay
all of them, so a string that stops being what the network says fails a test here before it misleads anyone.

Three of them are custom errors that no search engine can answer today, because they are four bytes with no name
attached: `0xffb9e6ed`, `0xace7dae0` and `0xa9688682`. They are the first three entries.

---

## `CONTRACT_REVERT_EXECUTED` and `error_message` is `0x`

**What it means.** The call failed and the reason was erased on the way out. SaucerSwap's custom errors are 36 bytes,
and a `multicall` keeps only revert data of 68 bytes or more, so what reaches you is an empty string. The transaction
was charged in full.

**What to do.** The reason survives one level down, in the mirror node's `/actions` view of the same transaction:
`https://testnet.mirrornode.hedera.com/api/v1/contracts/results/{hash}/actions`. Read the `result_data` of the
deepest `REVERT_REASON` and decode it with the next three entries. `postMortem` in
`packages/nextjs/lib/hedera/failure.ts` does exactly this and answers a sentence and an action.

**Captured in** `packages/nextjs/lib/hedera/__tests__/fixtures/mirror/result-token-to-hbar-no-allowance-292.json`,
with its call tree in `actions-token-to-hbar-no-allowance-292.json`.

## `0xffb9e6ed`

**What it means.** `RespCode(int32)`: the token service refused, and the 32 bytes that follow are a Hedera response
code, not an EVM error. `0x124` is 292, `SPENDER_DOES_NOT_HAVE_ALLOWANCE` — the router has no allowance to spend
your token. `0x125` is 293, `AMOUNT_EXCEEDS_ALLOWANCE`: an allowance exists and is smaller than the amount.

**What to do.** Read `allowance(owner, router)` before you send, and refuse the swap when it is below `amountIn` —
`>=`, never `> 0`. `checkAllowance` in `packages/nextjs/lib/hedera/preflight.ts` is that read; it costs nothing and
needs no key. No simulator will do it for you: `eth_call`, `eth_estimateGas` and the mirror node's own simulator all
accept the swap the network then refuses.

**Captured in** `packages/nextjs/lib/hedera/__tests__/fixtures/mirror/actions-token-to-hbar-no-allowance-292.json`
and `actions-token-to-hbar-allowance-too-small-293.json`.

## `0xace7dae0`

**What it means.** `TransferFail(int256)`: the transfer itself was refused, with the response code in the bytes that
follow. `0xb8` is 184, `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`; `0x11a` is 282, `INVALID_ALIAS_KEY`.

**What to do.** Those two look alike and want opposite things, so read the recipient before you send:
`checkRecipient` in `packages/nextjs/lib/hedera/preflight.ts` compares the address forms first, then the
associations, and answers one of six verdicts with the action for each.

**Captured in**
`packages/nextjs/lib/hedera/__tests__/fixtures/mirror/result-direct-unassociated-recipient-184.json`.

## `0xa9688682`

**What it means.** `HederaFail(int256)`: the position manager's own wrapper around a refusal. On a burn it carries
292, which here means the manager is not approved on the position NFT.

**What to do.** Send `setApprovalForAll` to the LP NFT for the position manager first. `checkPositionBurn` in
`packages/nextjs/lib/hedera/positionPreflight.ts` refuses to build the burn while that approval is missing;
simulation accepts it either way, which is why it has to be read rather than simulated.

**Captured in** `packages/nextjs/lib/hedera/__tests__/fixtures/position/burn-approval.json`, which holds the three
transactions of that morning: the burn the network refused with this error, the approval, and the burn that then
worked. The read that sees it coming is `packages/nextjs/lib/hedera/__tests__/fixtures/rpc/call-lp-nft-not-approved.json`.

---

## `execution reverted: CONTRACT_REVERT_EXECUTED, INSUFFICIENT_TOKEN_BALANCE`

**What it means.** Usually not a token balance at all. Inside the EVM every HBAR amount is tinybar; a transaction's
`value` is weibar, 10^10 times larger. Write the same figure in both and the router sees a payment worth a
hundred-millionth of what you meant, tries to pull wrapped HBAR from you instead, and fails on the token.

**What to do.** Build the value through `payable` in `packages/nextjs/lib/hedera/units.ts`, which is the only door
from one unit to the other, and never write a `value:` by hand. `yarn lint:strict` fails on one written outside that
module.

**Captured in** `packages/nextjs/lib/hedera/__tests__/fixtures/rpc/call-direct-unscaled-value-178.json` and
`estimate-multicall-unscaled-value.json`.

## `Value can't be non-zero and less than 10_000_000_000 wei which is 1 tinybar`

**What it means.** The relay refused the transaction before it reached consensus, with JSON-RPC code `-32602`. You
passed a tinybar figure where weibar was due, so the amount is below the smallest one Hedera can move.

**What to do.** Multiply by 10^10, or use `payable`. Note what the relay does *not* do for a value that is above one
tinybar but not a whole number of them: it carries it, charges it, and drops the remainder without a word.
`toTinybar` refuses that value rather than letting it through.

**Captured in** `packages/nextjs/lib/hedera/__tests__/fixtures/rpc/send-raw-value-below-one-tinybar.json`.

## `execution reverted: CONTRACT_REVERT_EXECUTED, TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`

**What it means.** The account you are paying has never held that token and has no free automatic-association slot,
so the token service refuses the transfer. The swap reverts and is charged anyway.

**What to do.** Associate the token from that account, or pay an account that has a free slot. `checkRecipient`
answers which of the two it is, including the case a wallet cannot see: a recipient that is not the sender.

**Captured in** `packages/nextjs/lib/hedera/__tests__/fixtures/rpc/call-direct-unassociated-184.json`.

## `execution reverted: CONTRACT_REVERT_EXECUTED, INVALID_ALIAS_KEY`

**What it means.** You paid the long-zero form of an account id — `0x` followed by the number in hexadecimal — for an
account that was born from an ECDSA key and has an EVM address of its own. The token service accepts only the second
form.

**What to do.** Read the account on the mirror node and pass its `evm_address`. `isLongZeroAddress` and
`checkRecipient` in this template make that comparison before they look at associations at all, because the failure
looks identical to a missing association and wants the opposite fix.

**Captured in** `packages/nextjs/lib/hedera/__tests__/fixtures/rpc/call-direct-long-zero-recipient-282.json`.

## `execution reverted: CONTRACT_REVERT_EXECUTED, INVALID_NFT_ID`

**What it means.** You are simulating a call that opens a liquidity position. Both simulators refuse it — and the
network executes it. The NFT it names does not exist yet, which is the point: the call is what mints it.

**What to do.** Supply the gas limit yourself, because nothing can estimate it. `gasRuleFor` and `withGasLimit` in
`packages/nextjs/lib/hedera/gasRules.ts` carry a rule for that call, and refuse to build it without one. A dApp that
lets the wallet estimate cannot open a position on Hedera today.

**Captured in** `packages/nextjs/lib/hedera/__tests__/fixtures/rpc/call-mint-not-estimable.json` and
`estimate-mint-not-estimable.json`.

## `RPC 0x128 Custom eth_sendRawTransaction: RPC endpoint returned HTTP client error.`

**What it means.** What a browser wallet says after it fails to send a call it could not price. On screen, the
network fee reads *Unavailable* and the send fails: the wallet asked the same simulators, got the entry above, and
has no figure to show. The message names no reason because the relay answers every refusal with the same HTTP error.

**What to do.** Hand the wallet a gas limit with the transaction. The same call with a limit this template supplies
went through.

**Captured in** `packages/nextjs/lib/hedera/__tests__/fixtures/wallet/metamask-send-refused-no-gas-limit.json`, and
the screen itself is `docs/images/wallet-fee-unavailable-mint.png`.

## `Unsupported method: wallet_sendTransaction`

**What it means.** The wallet said this, not the relay. EIP-1193 numbers provider errors in the 4000s, and this
one is 4200: the wallet does not serve the method the library used to send. viem asks `eth_sendTransaction`
first and falls back to `wallet_sendTransaction` only when the first is refused as unknown, so seeing the
fallback named means both were refused.

**What to do.** Read the account on the mirror node before you send again. The wallet may have executed the
transaction regardless. Measured on 30 September 2026 with HashPack over the generic WalletConnect connector: of
two sends, one was refused in the library and executed on the network all the same, charging 187,203 gas, while
the page was told the method was unsupported. `explainError` answers `wallet-unsupported` here, names the wallet
and says plainly that the relay never saw the request.

**Captured in** `packages/nextjs/lib/hedera/__tests__/fixtures/wallet/hashpack-send-unsupported.json`.

## `execution reverted: Too little received`

**What it means.** The pool would return less than the minimum you set. This one is honest: it is the slippage guard
doing its job, not a Hedera trap.

**What to do.** Quote again and widen the tolerance, or send a smaller amount. Quotes move between the read and the
send, and a minimum of zero is never the answer.

**Captured in** `packages/nextjs/lib/hedera/__tests__/fixtures/rpc/call-too-little-received.json`.

## `execution reverted: Invalid token ID`

**What it means.** The position serial you asked about no longer exists — usually because it was burnt, which is what
closing a position does.

**What to do.** Read the serial on the mirror node before asking the manager: `getNft` reports a burnt serial as
burnt instead of failing. `/positions` in this template lists what an account actually holds.

**Captured in** `packages/nextjs/lib/hedera/__tests__/fixtures/rpc/call-positions-burnt.json`.

## `Invalid parameter 0: Expected 0x prefixed string representing the address (20 bytes)`

**What it means.** JSON-RPC code `-32602`: you passed a Hedera account id, `0.0.1234`, where the relay wants a
20-byte address. The two name the same account and are not interchangeable at this seam.

**What to do.** Convert with `toEvmAddress` in `packages/nextjs/lib/hedera/evmAddress.ts`, or read the account's own
address on the mirror node — which is not always the long-zero form, as the `INVALID_ALIAS_KEY` entry above explains.

**Captured in** `packages/nextjs/lib/hedera/__tests__/fixtures/rpc/get-balance-invalid-address.json`.

## `contain timestamps that exceed the maximum allowed duration of 7 days`

**What it means.** JSON-RPC code `-32004`. The relay serves logs over a window of seven days at most, so a query that
asks for the history of a contract since its deployment is refused rather than truncated.

**What to do.** Ask in windows of a week or less, or read the transactions from the mirror node's REST API, which has
no such limit. This template reads history from the mirror node for that reason.

**Captured in** `packages/nextjs/lib/hedera/__tests__/fixtures/rpc/get-logs-span-over-7-days.json`.

---

## When the string is not here

`explainError` in `packages/nextjs/lib/hedera/failure.ts` takes whatever your tooling threw and answers a `kind`, a
`code`, a status name, one sentence and an action; `postMortem` does the same for a transaction that already
happened, reading the mirror node's `/actions` when the revert data was erased. Both are exported from
`~~/lib/hedera` and work in any project — see [`use-the-checks-in-your-app.md`](use-the-checks-in-your-app.md).

For the whole story behind each of these, with the transactions that prove it and what the mistake costs in HBAR,
read [`hedera-behaviour.md`](hedera-behaviour.md).
