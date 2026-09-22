# Test fixtures

Answers of Hedera testnet, replayed by the offline tests of `packages/nextjs/lib/hedera`: no test reaches the network, and nothing here was signed for them. The transactions below are the research probes' own, sent from account 0.0.10645914 on 21 Sept 2026.

## Mirror node answers

In `mirror/`, each file holds the HTTP status and the JSON body that https://testnet.mirrornode.hedera.com answered to one GET on 22 Sept 2026 at 14:40 UTC. The account answers leave out three fields the library never reads: the public key, which trips generic secret scanners, the transaction list and the paging links.

| file                                                        | GET, and what it shows                                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `mirror/result-token-to-hbar-no-allowance-292.json`         | /api/v1/contracts/results/0x756bfe64…dabc: SAUCE to HBAR with no allowance, reverted, empty revert data                    |
| `mirror/actions-token-to-hbar-no-allowance-292.json`        | the same transaction's /actions: RespCode(292) at call depths 1 to 3                                                       |
| `mirror/result-token-to-hbar-allowance-too-small-293.json`  | /api/v1/contracts/results/0x2eed251d…223c: an allowance of 10 SAUCE for 20, reverted, empty revert data                    |
| `mirror/actions-token-to-hbar-allowance-too-small-293.json` | its /actions: RespCode(293)                                                                                                |
| `mirror/result-multicall-unassociated-recipient-184.json`   | /api/v1/contracts/results/0x4d10ea98…a483: HBAR to SAUCE through multicall to a recipient without SAUCE, empty revert data |
| `mirror/actions-multicall-unassociated-recipient-184.json`  | its /actions: TransferFail(184)                                                                                            |
| `mirror/result-direct-unassociated-recipient-184.json`      | /api/v1/contracts/results/0xc0fb56df…976b: the same swap called directly, TransferFail(184) kept in error_message          |
| `mirror/result-hbar-to-token-success.json`                  | /api/v1/contracts/results/0x82c44f7a…ff9d: 1 HBAR to SAUCE, sent with viem 2.39.0                                          |
| `mirror/result-token-to-hbar-success.json`                  | /api/v1/contracts/results/0xf1c4aaa0…627d: 10 SAUCE to native HBAR in one multicall                                        |
| `mirror/result-associate-again-194.json`                    | /api/v1/contracts/results/0x6d58685d…225e: a second associate(), a successful transaction that returned 194                |
| `mirror/result-not-found.json`                              | /api/v1/contracts/results/ with a hash the network never saw: 404                                                          |
| `mirror/account-unlimited-slots.json`                       | /api/v1/accounts/0.0.10645914: an ECDSA account with its own EVM address and unlimited automatic associations              |
| `mirror/account-by-long-zero-address.json`                  | the same account asked for by its long-zero address                                                                        |
| `mirror/account-zero-slots-unassociated.json`               | /api/v1/accounts/0.0.10574825: no automatic association slot, no SAUCE                                                     |
| `mirror/account-zero-slots-associated.json`                 | /api/v1/accounts/0.0.10650085: no slot, SAUCE associated explicitly                                                        |
| `mirror/account-not-found.json`                             | /api/v1/accounts/ with an address no account has: 404                                                                      |
| `mirror/tokens-relation-explicit.json`                      | /api/v1/accounts/0.0.10650085/tokens?token.id=0.0.1183558                                                                  |
| `mirror/tokens-relation-automatic.json`                     | /api/v1/accounts/0.0.10645914/tokens?token.id=0.0.1183558                                                                  |
| `mirror/tokens-no-relation.json`                            | /api/v1/accounts/0.0.10574825/tokens?token.id=0.0.1183558: an empty list                                                   |
| `mirror/allowances-router-none.json`                        | /api/v1/accounts/0.0.10645914/allowances/tokens for the SwapRouter: no row                                                 |
| `mirror/allowances-position-manager.json`                   | the same for the position manager 0.0.1308184: 40 SAUCE left                                                               |

## JSON-RPC answers

In `rpc/`, each file holds the method, the HTTP status and the body that https://testnet.hashio.io/api (relay/0.78.5) answered. The first thirteen were captured on 22 Sept 2026 at 14:40 UTC by simulations from 0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01, which send nothing; the last five come from the logs of the research probes of 21 Sept 2026, which recorded the error object only: the jsonrpc and id fields around it were added.

| file                                             | request, and what it shows                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `rpc/call-too-little-received.json`              | eth_call, direct exactInput with an unreachable minimum: Error("Too little received")                                     |
| `rpc/call-direct-unassociated-184.json`          | eth_call, direct exactInput to 0.0.10574825: TransferFail(184)                                                            |
| `rpc/call-multicall-unassociated-184.json`       | the same through multicall: empty data, the status name in the message                                                    |
| `rpc/call-direct-long-zero-recipient-282.json`   | eth_call, direct exactInput to the long-zero address of 0.0.10574825: TransferFail(282)                                   |
| `rpc/call-allowance-router-zero.json`            | eth_call, SAUCE allowance(0.0.10645914, SwapRouter): 0                                                                    |
| `rpc/call-allowance-position-manager.json`       | eth_call, SAUCE allowance(0.0.10645914, position manager): 40000000                                                       |
| `rpc/call-quote-hbar-to-sauce.json`              | eth_call, QuoterV2 quoteExactInput of 1 HBAR to SAUCE                                                                     |
| `rpc/call-quote-sauce-to-hbar.json`              | eth_call, QuoterV2 quoteExactInput of 10 SAUCE to HBAR                                                                    |
| `rpc/call-token-to-hbar-allowance-zero.json`     | eth_call, SAUCE to HBAR multicall with allowance 0: accepted, although the network rejects it                             |
| `rpc/estimate-token-to-hbar-allowance-zero.json` | eth_estimateGas of that same multicall: answered too                                                                      |
| `rpc/estimate-hbar-to-token.json`                | eth_estimateGas, 1 HBAR to SAUCE for an associated recipient                                                              |
| `rpc/gas-price.json`                             | eth_gasPrice                                                                                                              |
| `rpc/chain-id.json`                              | eth_chainId                                                                                                               |
| `rpc/send-raw-value-below-one-tinybar.json`      | eth_sendRawTransaction with a value of 10^8 weibar: HTTP 400, -32602 (research logs, w3-probes 30-c04v-swap.log line 111) |
| `rpc/estimate-multicall-unscaled-value.json`     | eth_estimateGas of the multicall with that value: INSUFFICIENT_TOKEN_BALANCE, empty data (same log, line 94)              |
| `rpc/call-direct-unscaled-value-178.json`        | eth_call of the direct exactInput with that value: RespCode(178) (w3-probes 20-c15-viem-2.39.0.log line 112)              |
| `rpc/call-quote-no-pool.json`                    | eth_call, a quote through a fee tier with no pool: empty data (same log, line 87)                                         |
| `rpc/get-logs-span-over-7-days.json`             | eth_getLogs over 9.37 days: HTTP 400, -32004 (same log, line 16)                                                          |

## Lint fixture

`lint/plantedValueViolations.ts` is written for this repository: planted violations of the transaction-value lint guard, which `lintGuard.test.ts` lints as a file of the app's hooks directory.
