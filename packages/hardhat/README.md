# Hardhat package

Contracts, deploy scripts and tests of this project, on Hardhat 2.22.19 with hardhat-deploy. Run the commands from the repository root.

## The contract this template ships

`SaucerSwapHbarConsumer.sol` swaps the HBAR sent with a call for SAUCE on SaucerSwap V2 and keeps the tokens. It is what "from your own Solidity contract" means here, and two Hedera behaviours shape it:

- **Every HBAR amount it sees is tinybar**, eight decimals. A JSON-RPC caller signs `value` in weibar, tinybar times 10^10, and the network divides it before the contract runs. The same rule on the caller's side lives in `packages/nextjs/lib/hedera/units.ts`.
- **A contract cannot receive an HTS token it has never held.** The constructor associates the contract with the output token through the system contract at `0x167` and refuses to exist unless the token service answers 22, so the deployer pays for the relation once instead of every swap paying for it. The token service answers a response code instead of reverting, which is why the return value is read at all: `docs/hedera-behaviour.md` has the transaction where ignoring it cost 0.79 HBAR for nothing.

Its interfaces are written from the deployed contracts' function shapes, under the MIT licence; no SaucerSwap, Uniswap or Hedera source file is vendored.

## Tests

```bash
yarn test:mock   # offline, about a second
yarn test        # needs the network
```

`test/mock/` is the tier that runs everywhere. Three original mocks from `contracts/mocks/` are put at the addresses the token service, SAUCE and the router have on testnet, with `hardhat_setCode`, so the contract under test is built with the same address book a deployment uses. They reproduce the failures measured on testnet: 194 for a second association, `TransferFail(184)` for a recipient that cannot hold the token, no data at all once `multicall` has erased it, and `RespCode(178)` when the router is paid nothing for the amount it is asked to swap.

`test/fork/` covers the inherited sample contracts against an in-process fork of Hedera testnet read through hashio, where `@hashgraph/system-contracts-forking` emulates the token service. A fork has no code at any long-zero contract, never enforces association and turns every service failure into code 21, so it is not where the behaviour above is checked. `HEDERA_FORKING` picks the tier: it selects the network and the directory of tests in `hardhat.config.ts`.

## Local fork

1. Start a fork of Hedera testnet (terminal 1):
   ```bash
   yarn hardhat:chain
   ```
   This is `hardhat node` with `HEDERA_FORKING=true`, so that `@hashgraph/system-contracts-forking` emulates the token service. JSON-RPC is served on http://127.0.0.1:8545.
2. Deploy the sample contracts to it (terminal 2):
   ```bash
   yarn hardhat:deploy:localhost
   ```
   `hardhat:deploy` without a network deploys to the in-process network instead: a separate network, without token-service emulation, where the HTS step (`02_create_hts_token.ts`) stops with `invalid opcode`.
3. Run the tests:
   ```bash
   yarn test
   ```
   They start their own in-process fork, which reads Hedera testnet through hashio: they need the network.

## Hedera testnet

1. Create a deployer key, stored encrypted as `DEPLOYER_PRIVATE_KEY_ENCRYPTED` in `packages/hardhat/.env`:
   ```bash
   yarn hardhat:account:generate
   ```
   `yarn hardhat:account:import` stores an existing key the same way.
2. Fund its address from the [Hedera Portal faucet](https://portal.hedera.com/faucet). `yarn hardhat:account` asks for the password and prints the address and its balances.
3. Deploy; the script asks for the key's password:
   ```bash
   yarn hardhat:deploy:testnet
   ```
   Without a stored key it stops with exit code 1 before deploying anything. For a non-interactive deploy, set `__RUNTIME_DEPLOYER_PRIVATE_KEY` in the shell for that one command: no other variable is read, and there is no fallback key.

   `yarn hardhat:deploy:consumer:testnet` deploys the SaucerSwap consumer alone, without the inherited sample contracts.

4. Show its source, so that anyone can read what the address runs:
   ```bash
   yarn hardhat:verify:testnet
   ```
   It submits each deployment of that network to Sourcify's v2 API and fails on anything short of a full match. The verification tooling a Scaffold-HBAR project inherits calls Sourcify's v1 endpoints, and those were removed: both `hardhat-verify` and hardhat-deploy's own `sourcify` task now get an HTML 404 page where they expect a result.

After each deploy, the deploy task writes the addresses and ABIs to `packages/nextjs/contracts/deployedContracts.ts`, and prints one mirror-node URL and one Hashscan URL per deployment. Hashscan answers HTTP 404 to anything that is not a browser, so the mirror URL is the one a script or a link checker can read.

## Layout

- `contracts/`: `SaucerSwapHbarConsumer.sol` and its own `interfaces/`; `mocks/` for the offline tier; and the inherited samples `HederaToken.sol`, an ERC-20 whose `mint` is `onlyOwner`, and `HtsTokenCreator.sol`, which creates and mints an HTS token through the system contract at `0x167` (`createToken` is payable: the HTS fee comes from `msg.value`)
- `deploy/`: hardhat-deploy scripts, run in file-name order
- `scripts/`: the deployer-account scripts, the deploy wrapper `runHardhatDeployWithPK.ts`, the Sourcify verification `verifySourcify.ts`, the ABI generation for the frontend
- `test/`: Mocha and Chai tests, `mock/` offline and `fork/` against a fork of Hedera testnet
- `utils/`: the deployer-key variable names and messages, the gas-price helper, the SaucerSwap testnet addresses, the mirror and Hashscan link builders
- `hardhat.config.ts`: the networks `hardhat` (in-process, forking Hedera testnet only with `HEDERA_FORKING`), `localhost` (http://127.0.0.1:8545), `hederaTestnet` (chain id 296) and `hederaMainnet` (295), and the guard that stops a deploy to a network without a signer
