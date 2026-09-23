# Agent guide

Hardhat-only Scaffold-HBAR base: a Next.js app in `packages/nextjs`, a Hardhat package in `packages/hardhat`, and the tooling that checks both in `tools/`. Claude Code loads this file through `CLAUDE.md`.
Run every command from the repository root. The commands below are spelled for the package manager this project was scaffolded with; the CLI rewrites them when it scaffolds for npm.

Stack: Node.js 20.18.3 or later, TypeScript in strict mode, Next.js 15 (app directory), RainbowKit 2.2.9, wagmi 2.19.5, viem 2.39.0, DaisyUI 5, Hardhat 2.22.19 with hardhat-deploy, Solidity 0.8.28.

## Commands

```bash
yarn dev                        # development server, http://localhost:3000
yarn build                      # production build of packages/nextjs
yarn serve                      # production server for that build, http://localhost:3000
yarn lint:strict                # ESLint and Prettier on both packages, no warning allowed
yarn typecheck                  # TypeScript on both packages, after compiling the contracts
yarn test:unit                  # Vitest tests of packages/nextjs/lib/hedera and the mirror relay; no network, no key
yarn test                       # Hardhat tests on a fork of Hedera testnet: needs the network
yarn format                     # Prettier on both packages and on tools/
yarn check:tools                # formatting of tools/, types and tests of tools/checks and tools/gate; no network
yarn check:docs                 # docs, manifest, npm-mode rewrite, evidence figures and hygiene checks (tools/checks)
yarn check:all                  # lint:strict, typecheck, check:tools, probe:routes:check, check:docs; needs the registry
yarn probe:routes               # every page route in Chromium, three network modes; after build, port 3000
yarn gate:local                 # scaffold HEAD through the published CLI and check the result; slow, over 1 GB
yarn check:live                 # keyless reads of Hedera testnet, then evidence:check; third parties, network needed
yarn evidence:check             # re-read every file of docs/evidence/ from the mirror node; no key
yarn evidence                   # sign every evidence scenario on testnet, write docs/evidence/; ask first
yarn evidence:consumer          # one of them: a swap through the deployed consumer; ask first, see Boundaries
yarn evidence:position          # one of them: open, read and close a liquidity position; ask first, see Boundaries
yarn hardhat:chain              # fork of Hedera testnet, JSON-RPC on http://127.0.0.1:8545
yarn hardhat:deploy:localhost   # deploy the sample contracts to that fork
yarn hardhat:account:generate   # new deployer key, stored encrypted in packages/hardhat/.env
yarn hardhat:deploy:testnet     # deploy to Hedera testnet; asks for the key's password
```

A script that needs a flag gets a flag-free alias, as `lint:strict` and `hardhat:deploy:testnet` do: in a project scaffolded for npm, the CLI turns each documented command into `npm run <script>`, and a flag that follows it goes to npm, not to the script.

## Verify your change

Run these before you stop, and fix what fails:

1. `yarn format`
2. `yarn check:all`. It needs the package registry: it reinstalls the route probe, and the docs checks download the published CLI.
3. Changed anything under `packages/nextjs`: `yarn test:unit`, `yarn build`, then `yarn probe:routes`.
4. Changed anything under `packages/hardhat`: `yarn test:mock`, then `yarn test`. The second fails when hashio, the public relay the fork reads, is down; run it again before you debug.
5. Changed `template.json`, a `package.json`, the lockfile or a workflow: `yarn gate:local`. It scaffolds the committed HEAD, so commit first.
6. `git status` lists only the files you meant to change, and no command above modified a tracked file.

## Critical invariants

- On page load the browser calls the app's own origin only. Hedera JSON-RPC goes through `packages/nextjs/app/api/hedera/rpc/route.ts` and mirror-node reads through `packages/nextjs/app/api/hedera/account/route.ts` and `packages/nextjs/app/api/hedera/mirror/route.ts`; all three answer HTTP 200 with a typed body when the upstream fails or answers 4xx, because a browser logs every response of 400 or more as a console error. `yarn probe:routes` fails a route on any console error and on any request to a third-party host.
- A Hedera transaction value is weibar (tinybar × 10^10) while every amount inside a call is tinybar. Outside `packages/nextjs/lib/hedera`, code never writes a `value:` in a transaction call and never imports `parseEther` or `formatEther`: spread `payable(amount)` from `~~/lib/hedera`. `yarn lint:strict` fails on those imports, on `parseUnits(amount, 18)`, and on a `value:` written in the object passed to a viem action or wagmi hook that sends, simulates, estimates, prepares or deploys (the list is in `packages/nextjs/eslint.config.mjs`) or in a request object built before such a call, recognised by two keys next to it: something the call is aimed at (`to`, `address`, `abi` or `bytecode`) and a field only a transaction carries (`account`, `chain`, `chainId`, `data`, `functionName`, `args`, `gas` or `nonce`). It covers the folders that `lint:all` in `packages/nextjs/package.json` lists: app, components, hooks, lib, services and utils. The guard reads syntax: a value spread from a variable, or set on an object carrying at most one of those keys, is not reported — `to`, `data` and `functionName` are ordinary property names, and a chart row or a form field is not a transaction. `packages/nextjs/lib/hedera/__tests__/fixtures/lint/plantedValueViolations.ts` holds both halves, the violations the rule must report and the shapes it must leave alone.
- A call that neither `eth_call` nor `eth_estimateGas` will price needs a gas limit from the dapp, or no wallet can send it. The calls, the limit for each and the executed transactions each limit comes from are in `packages/nextjs/lib/hedera/gasRules.ts`; `withGasLimit` refuses to build such a call without one, and `checkCost` previews from the rule's limit instead of an estimate. `explainError` answers `not-estimable` with the action `supply-gas` and points at that module, but only when its `FailureContext` names the contract and the functions of the call and a rule covers them: `INVALID_NFT_ID` also means a serial that does not exist, and a wallet's refusal sentence names no cause at all, so told nothing about the call it reports the refusal instead. Advising a gas limit for a call the network prices sends a transaction the network refuses and charges for. Add a rule there, never a number in a page: a page builds a call and then passes it through `withRuleGasLimit` from `packages/nextjs/components/hedera/gasLimit.ts`, which asks the rules for it and carries the limit the rule names.
- An address in `packages/nextjs/lib/hedera` is its own `EvmAddress` (`0x${string}`), never viem's `Address`. `packages/nextjs/types/abitype/abi.d.ts` registers `string` as abitype's address type, which is what the stock hooks and the debug UI accept from an address input; that registration names viem's own copy of abitype by its path, and where the copy sits depends on which package manager installed the project, so viem's `Address` is a plain string in one project and `0x${string}` in another. Take an address that arrives as a string through `toEvmAddress` from `~~/lib/hedera`, which returns its checksummed form and refuses anything else; `isEvmAddress` is the twin that narrows instead of throwing. `packages/nextjs/lib/hedera/__tests__/evmAddress.test.ts` fails `yarn typecheck` as soon as a public type of the library takes its address from viem again. What the library returns is the same in both projects; what viem returns is not, so an address typed by viem or wagmi, a `useAccount` address for one, still type-checks into the library in one project and not in the other: pass it through `toEvmAddress`, which compiles in both.
- Show users the `message` of `explainError` from `~~/lib/hedera`, never viem's `shortMessage`: with the pinned viem 2.39.0, a relay refusal answered with HTTP 400 (hashio called directly, as a Node script does) reads "HTTP request failed." there, and the relay's own sentence survives only in `details`.
- No fallback key, anywhere. Live networks in `packages/hardhat/hardhat.config.ts` sign only with `__RUNTIME_DEPLOYER_PRIVATE_KEY`, which the deploy script sets for its own run from the encrypted key; without it they get no account and the deploy task refuses to run. Hardhat's well-known account #0 is a funded account on Hedera testnet.
- The WalletConnect project id comes from the environment only. Without it, `packages/nextjs/services/web3/wagmiConnectors.tsx` offers browser-injected and burner wallets and creates no WalletConnect connector.
- `packages/nextjs/contracts/deployedContracts.ts` is generated by the deploy task: never edit it by hand. Third-party contracts go in `packages/nextjs/contracts/externalContracts.ts`.
- `HEDERA_FORKING` is set by the `chain` and `test` scripts of `packages/hardhat` only, and it picks the whole fork tier: the forking plugin, the in-process network's fork, and `packages/hardhat/test/fork/` as the directory of tests. A deploy to an already running node must not load that plugin: its worker port would be taken (`EADDRINUSE`). Without the variable nothing touches the network and `packages/hardhat/test/mock/` runs.
- Keep the `@x402/*` guard in `packages/nextjs/next.config.ts`: without it the production build fails as soon as `@coinbase/cdp-sdk` resolves to a release that lazy-imports the optional `@x402/*` packages (1.53 and later), which a fresh npm-mode install does.
- Workspace scripts (`packages/*/package.json`) call binaries directly (`hardhat compile`, `tsc`), set variables with `cross-env`, never with an inline `VAR=value`, and quote globs with double quotes: on Windows, scripts run through `cmd.exe` under npm.
- A root script that passes a flag to another root script calls it by its `next:` or `hardhat:` alias, as `lint:strict` does: in a project scaffolded for npm, the CLI adds the `--` that forwards the flag only after those prefixes and a few stock names such as `test`, so after any other name the flag would go to npm.
- Text that the CLI rewrites for npm (Markdown, JSON, TypeScript and JavaScript sources, YAML, `.env.example` files and a few more; not TSX, Solidity or shell scripts) never names the default package manager in prose, never has `npm` directly followed by a word other than `run`, `install`, `exec` or `ci`, and never ends a line with `npm`. `yarn check:docs` replays the CLI's rewrite and reports each such line.
- Every path, script, symbol and variable named in a README or in this file exists; `yarn check:docs` checks them. A deliberate exception is declared in a `checks:allow` comment, as at the end of this file.
- LF line endings, enforced by `.gitattributes`; no symbolic links, which the CLI drops on Windows.

## Layout

| Path | What |
| --- | --- |
| `packages/nextjs/app/page.tsx` | home route |
| `packages/nextjs/app/swap/page.tsx` | Swap route: a SaucerSwap V2 swap both ways, with the pre-flight checks, the cost preview and the mirror-node post-check; `packages/nextjs/components/swap/` holds it |
| `packages/nextjs/app/positions/page.tsx` | Positions route: the connected account's V2 liquidity positions, read-only — their range against the pool's live tick and what closing one would return; `packages/nextjs/components/positions/` holds it |
| `packages/nextjs/components/hedera/` | what both routes show and ask: the failure note, the words for the action to take, the mirror and Hashscan links, and `withRuleGasLimit`, the one door from a page to `packages/nextjs/lib/hedera/gasRules.ts` |
| `packages/nextjs/app/debug/page.tsx` | Debug Contracts route: reads and writes every deployed contract |
| `packages/nextjs/app/api/hedera/rpc/route.ts` | same-origin JSON-RPC relay, `POST /api/hedera/rpc?network=testnet` or `mainnet` |
| `packages/nextjs/app/api/hedera/account/route.ts` | account id of an EVM address, from the mirror node |
| `packages/nextjs/app/api/hedera/mirror/route.ts` | same-origin relay for the mirror reads of `packages/nextjs/lib/hedera`, `GET /api/hedera/mirror?network=testnet&path=…` |
| `packages/nextjs/lib/hedera/` | units, the address type and the testnet address book, ABIs, error decoding, mirror client, pre-send checks, swap builders, evidence records; `index.ts` is its public surface |
| `packages/nextjs/lib/hedera/__live__/` | the live tiers: keyless checks of Hedera testnet, and the signed evidence runs `swaps.signed.ts` and `positions.signed.ts` |
| `docs/evidence/` | one JSON record per signed scenario: hashes, mirror URLs, fees, amounts, versions; re-checked by `yarn evidence:check` |
| `packages/nextjs/services/hedera/` | relay logic, upstream URLs, structured server log |
| `packages/nextjs/scaffold.config.ts` | target networks, RPC overrides pointing at the relay, WalletConnect project id |
| `packages/nextjs/hooks/scaffold-hbar/` | contract hooks |
| `packages/hardhat/contracts/` | `SaucerSwapHbarConsumer.sol`, the consumer this template deploys and verifies, its own minimal `interfaces/`, the `mocks/` the mock tier injects, and the inherited samples `HederaToken.sol` and `HtsTokenCreator.sol` |
| `packages/hardhat/deploy/` | hardhat-deploy scripts, run in file-name order |
| `packages/hardhat/test/` | Mocha and Chai tests: `mock/` offline, `fork/` against a fork of Hedera testnet |
| `packages/hardhat/scripts/runHardhatDeployWithPK.ts` | the deploy wrapper: key handling, then `hardhat deploy` |
| `packages/hardhat/scripts/verifySourcify.ts` | Sourcify v2 verification of what was deployed, the v1 endpoints being gone |
| `tools/checks/` | repository checks and their tests |
| `tools/route-probe/` | browser probe; standalone package outside the workspaces, installed from its own lockfile |
| `tools/gate/` | scaffold gate scripts |
| `.github/workflows/` | `gate.yml` (template repository), `gate-skeleton.yml` and `hosts-control.yml` (public skeleton only), `lint.yaml` |
| `template.json` | the CLI's manifest: capabilities, env variables, closing message. Template repository only: the CLI deletes it from every scaffold |

## Frontend patterns

Read and write a deployed contract through the hooks of `~~/hooks/scaffold-hbar`: `useScaffoldReadContract` and `useScaffoldWriteContract` (not `useScaffoldContractRead` or `useScaffoldContractWrite`). Also there: `useScaffoldWatchContractEvent`, `useScaffoldEventHistory`, `useDeployedContractInfo`, `useTransactor`.

```tsx
"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-hbar";

export const ConsumerHoldings = () => {
  const { address } = useAccount();
  const [failure, setFailure] = useState<string>();
  const { data: held } = useScaffoldReadContract({
    contractName: "SaucerSwapHbarConsumer",
    functionName: "tokenBalance",
  });
  const { writeContractAsync, isPending } = useScaffoldWriteContract({ contractName: "SaucerSwapHbarConsumer" });

  const associate = async () => {
    setFailure(undefined);
    try {
      // The constructor already did this; a second association answers 194, which the contract reads as done.
      await writeContractAsync({ functionName: "associate" });
    } catch (error: unknown) {
      // The transactor has already shown a notification; keep the reason next to the button too.
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p>The contract holds {held?.toString() ?? "unknown"} SAUCE units</p>
      <button className="btn btn-primary" disabled={!address || isPending} onClick={associate}>
        Associate again
      </button>
      {failure && <p className="text-error">{failure}</p>}
    </div>
  );
};
```

UI components come from `@scaffold-hbar-ui/components`: `Address`, `Balance`, `HederaAddressInput`, `HbarInput`, `HederaPortalFaucet`. It has no `AddressInput` or `EtherInput`, names that other Scaffold-ETH 2 guides use. Prefer DaisyUI classes (`btn`, `card`, `text-error`) to raw Tailwind when one exists. Imports inside the app use the `~~` alias. A page that uses hooks starts with `"use client"`.

## Testing

- `yarn test:mock` runs `packages/hardhat/test/mock/` on the plain in-process network: no fork, no plugin, no network call, about a second. Three original mocks (`packages/hardhat/contracts/mocks/`) are put at the addresses the token service, SAUCE and the router have on testnet with `hardhat_setCode`, so the contract under test is built with the real address book. They reproduce the failures measured on testnet — 194, `TransferFail(184)`, the empty data `multicall` leaves, `RespCode(178)` — because a fork reproduces none of them.
- `yarn test` runs `packages/hardhat/test/fork/` against an in-process fork of Hedera testnet read through hashio, where `@hashgraph/system-contracts-forking` emulates the token service at `0x167`. The forking worker binds port 10001, so two runs cannot share a machine. `HEDERA_FORKING` picks the tier: it selects both the network and the directory of tests in `packages/hardhat/hardhat.config.ts`.
- The tooling tests use `node:test` and need no network: `tools/checks/test/`, `tools/gate/routes.test.mjs` (both in `yarn check:tools`) and `tools/route-probe/test/` (`yarn probe:routes:check`). Tests sit next to the tool they cover.
- `yarn test:unit` runs Vitest on `packages/nextjs/lib/hedera/__tests__/`, `packages/nextjs/services/hedera/__tests__/` and the `__tests__/` directories of `packages/nextjs/components/`. The fixtures are answers captured from Hedera testnet and replayed through viem's own transport, so the error objects are those viem 2.39.0 builds; `packages/nextjs/lib/hedera/__tests__/fixtures/README.md` says where each came from. No network, no key, a few seconds.
- `yarn check:live` runs the files of `packages/nextjs/lib/hedera/__live__/` that end in .live.ts, through `packages/nextjs/vitest.live.config.ts`: keyless reads of Hedera testnet (the address book against the router, the factory and the token facades; a quote; the dated observation that three simulators accept a SAUCE to HBAR swap with no allowance) and `yarn evidence:check`. A failure there can be hashio's or the mirror node's: run it again before you debug. `.github/workflows/gate.yml` runs it nightly, never blocking.
- `yarn evidence` runs every `*.signed.ts` of `packages/nextjs/lib/hedera/__live__/` through `packages/nextjs/vitest.evidence.config.ts`, and each of `yarn evidence:consumer` and `yarn evidence:position` runs one of them by name. They sign with `__RUNTIME_DEPLOYER_PRIVATE_KEY` from the shell, write one file per scenario to `docs/evidence/`, and are skipped, exit 0, when the variable is not set. A new scenario re-checks its record with `checkEvidence` before writing it, as the existing ones do.
- The scenario of `packages/nextjs/lib/hedera/__live__/positions.signed.ts` is one whole life cycle of a SaucerSwap V2 position. Its record carries a `position` instead of a `swap`, `checkPositionEvidence` is what re-reads it, its file is named after the serial it opened, and the run closes that position even when a step of it fails.
- The files of `docs/evidence/` are produced by `yarn evidence`, `yarn evidence:consumer` and `yarn evidence:position` only: never write or edit one by hand. `yarn evidence:check` fails on any figure that differs from the mirror node. A doc quotes their figures only inside a `checks:evidence` block, which `yarn check:docs` renders from the files the block names and compares line by line; it also fails when a doc names an older record of a scenario than the newest one.
- What a page renders has no unit test: `yarn probe:routes` is its check, each page route in three network modes, zero console errors, zero third-party requests. What a page decides does have one, next to the components, as `packages/nextjs/components/swap/__tests__/` and `packages/nextjs/components/positions/__tests__/` show: the reads of `swapPlan.ts` and of `positionsRead.ts` are an argument, so every refusal is tested without a network. Whether the Send button may act is `sendIsBlocked` in `packages/nextjs/components/swap/swapPresentation.ts` and never a condition written in the JSX: the panel disables the button with it and the handler asks it again, so the one safety property of the route is in a place a test can fail on. A new page is probed without any change; a new dynamic route needs a sample in `tools/route-probe/probe.config.json`.
- A test name states the rule it enforces. A check proves that it can fail: the route probe runs six loads that must fail on every invocation, and the repository checks are tested against fixtures that must fail.

## Boundaries

Always:
- run the steps of "Verify your change" before you stop;
- document a flag-free alias script, never a command with a flag;
- keep keys out of files: the deployer key lives encrypted in `packages/hardhat/.env`, or in the shell for one command.

Ask first:
- adding or upgrading a dependency: it changes the lockfile, and an install under `CI=true` fails when the committed lockfile would have to change. The Vite that Vitest runs on is held at 6.4.3 by a resolution recorded in the lockfile only, not in a `package.json`: a lockfile generated again resolves Vite 7, which declares Node.js 20.19 or later, above this project's floor. An npm-mode install never reads that lockfile; it gets one Vite 6 because the direct `vite` devDependency of `packages/nextjs` also satisfies Vitest's range;
- renaming or removing a root script: the gate calls `lint:strict`, `typecheck`, `build`, `test`, `serve`, `probe:routes` and `check:docs`, and the closing message of `template.json` names others;
- changing `template.json`, a workflow, or `.gitleaks.toml`;
- anything that deploys, signs or spends on a live network.

Never:
- commit an env file or a key, or add a fallback key;
- call a third-party host from the browser on page load;
- edit `packages/nextjs/contracts/deployedContracts.ts` by hand;
- add a symbolic link;
- edit the agent kit that comes with Scaffold-HBAR (`.agents/`, `.claude/`) or what the skills install adds (`agent/`, `skills-lock.json`);
- rename `main`, rewrite pushed history, or add an AI co-author or `Signed-off-by` trailer to a commit.

## Git

Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `ci:`, with an optional scope such as `fix(nextjs):`. Imperative, lowercase subject; the body says why; one logical change per commit. In a project scaffolded with the default package manager, a pre-commit hook lints the staged files and type-checks the frontend.

## Code style

TypeScript strict; `type` over `interface`; no `T` prefix on type names. Prettier with a print width of 120 in both packages and in `tools/`. Contracts: Solidity 0.8.28, OpenZeppelin 5. Errors are handled or propagated with their cause, never swallowed; server code logs through `packages/nextjs/services/hedera/serverLog.ts`, never with a bare `console.log`. Comments say what the code cannot.

<!-- checks:allow
paths: agent skills-lock.json template.json
symbols: useScaffoldContractRead useScaffoldContractWrite AddressInput EtherInput
-->
