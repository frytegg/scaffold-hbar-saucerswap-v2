# Hardhat package

Contracts, deploy scripts and tests of this project, on Hardhat 2.22.19 with hardhat-deploy. Run the commands from the repository root.

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

After each deploy, the deploy task writes the addresses and ABIs to `packages/nextjs/contracts/deployedContracts.ts`.

## Layout

- `contracts/`: `HederaToken.sol`, an ERC-20 whose `mint` is `onlyOwner`, and `HtsTokenCreator.sol`, which creates and mints an HTS token through the system contract at `0x167` (`createToken` is payable: the HTS fee comes from `msg.value`)
- `deploy/`: hardhat-deploy scripts, run in file-name order
- `scripts/`: the deployer-account scripts, the deploy wrapper `runHardhatDeployWithPK.ts`, the ABI generation for the frontend
- `test/`: Mocha and Chai tests
- `utils/`: the deployer-key variable names and messages, the gas-price helper
- `hardhat.config.ts`: the networks `hardhat` (in-process fork), `localhost` (http://127.0.0.1:8545), `hederaTestnet` (chain id 296) and `hederaMainnet` (295), and the guard that stops a deploy to a network without a signer
