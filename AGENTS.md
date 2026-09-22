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
yarn check:docs                 # docs, manifest, npm-mode rewrite and hygiene checks (tools/checks)
yarn check:all                  # lint:strict, typecheck, check:tools, probe:routes:check, check:docs; needs the registry
yarn probe:routes               # every page route in Chromium, three network modes; after build, port 3000
yarn gate:local                 # scaffold HEAD through the published CLI and check the result; slow, over 1 GB
yarn check:live                 # keyless reads of Hedera testnet, then evidence:check; third parties, network needed
yarn evidence:check             # re-read every file of docs/evidence/ from the mirror node; no key
yarn evidence                   # sign two swaps on Hedera testnet, write docs/evidence/; ask first, see Boundaries
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
4. Changed anything under `packages/hardhat`: `yarn test`. It fails when hashio, the public relay the fork reads, is down; run it again before you debug.
5. Changed `template.json`, a `package.json`, the lockfile or a workflow: `yarn gate:local`. It scaffolds the committed HEAD, so commit first.
6. `git status` lists only the files you meant to change, and no command above modified a tracked file.

## Critical invariants

- On page load the browser calls the app's own origin only. Hedera JSON-RPC goes through `packages/nextjs/app/api/hedera/rpc/route.ts` and mirror-node reads through `packages/nextjs/app/api/hedera/account/route.ts` and `packages/nextjs/app/api/hedera/mirror/route.ts`; all three answer HTTP 200 with a typed body when the upstream fails or answers 4xx, because a browser logs every response of 400 or more as a console error. `yarn probe:routes` fails a route on any console error and on any request to a third-party host.
- A Hedera transaction value is weibar (tinybar × 10^10) while every amount inside a call is tinybar. Outside `packages/nextjs/lib/hedera`, code never writes a `value:` in a transaction call and never imports `parseEther` or `formatEther`: spread `payable(amount)` from `~~/lib/hedera`. `yarn lint:strict` fails on those imports, and on a `value:` written in the object passed to a viem action or wagmi hook that sends, simulates, estimates, prepares or deploys (the list is in `packages/nextjs/eslint.config.mjs`), in the folders that `lint:all` in `packages/nextjs/package.json` lists: app, components, hooks, lib, services and utils. The guard reads syntax: a value set on an object built before the call is not reported, so review that pattern by hand.
- Show users the `message` of `explainError` from `~~/lib/hedera`, never viem's `shortMessage`: with the pinned viem 2.39.0, a relay refusal answered with HTTP 400 (hashio called directly, as a Node script does) reads "HTTP request failed." there, and the relay's own sentence survives only in `details`.
- No fallback key, anywhere. Live networks in `packages/hardhat/hardhat.config.ts` sign only with `__RUNTIME_DEPLOYER_PRIVATE_KEY`, which the deploy script sets for its own run from the encrypted key; without it they get no account and the deploy task refuses to run. Hardhat's well-known account #0 is a funded account on Hedera testnet.
- The WalletConnect project id comes from the environment only. Without it, `packages/nextjs/services/web3/wagmiConnectors.tsx` offers browser-injected and burner wallets and creates no WalletConnect connector.
- `packages/nextjs/contracts/deployedContracts.ts` is generated by the deploy task: never edit it by hand. Third-party contracts go in `packages/nextjs/contracts/externalContracts.ts`.
- `HEDERA_FORKING` is set by the `chain` and `test` scripts of `packages/hardhat` only. It loads the forking plugin, which a deploy to an already running node must not load: its worker port would be taken (`EADDRINUSE`).
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
| `packages/nextjs/app/debug/page.tsx` | Debug Contracts route: reads and writes every deployed contract |
| `packages/nextjs/app/api/hedera/rpc/route.ts` | same-origin JSON-RPC relay, `POST /api/hedera/rpc?network=testnet` or `mainnet` |
| `packages/nextjs/app/api/hedera/account/route.ts` | account id of an EVM address, from the mirror node |
| `packages/nextjs/app/api/hedera/mirror/route.ts` | same-origin relay for the mirror reads of `packages/nextjs/lib/hedera`, `GET /api/hedera/mirror?network=testnet&path=…` |
| `packages/nextjs/lib/hedera/` | units, testnet address book, ABIs, error decoding, mirror client, pre-send checks, swap builders, evidence records; `index.ts` is its public surface |
| `packages/nextjs/lib/hedera/__live__/` | the live tiers: keyless checks of Hedera testnet, and `swaps.signed.ts`, the signed evidence run |
| `docs/evidence/` | one JSON record per signed scenario: hashes, mirror URLs, fees, amounts, versions; re-checked by `yarn evidence:check` |
| `packages/nextjs/services/hedera/` | relay logic, upstream URLs, structured server log |
| `packages/nextjs/scaffold.config.ts` | target networks, RPC overrides pointing at the relay, WalletConnect project id |
| `packages/nextjs/hooks/scaffold-hbar/` | contract hooks |
| `packages/hardhat/contracts/` | `HederaToken.sol` (ERC-20) and `HtsTokenCreator.sol` (HTS through `0x167`) |
| `packages/hardhat/deploy/` | hardhat-deploy scripts, run in file-name order |
| `packages/hardhat/test/` | Mocha and Chai tests |
| `packages/hardhat/scripts/runHardhatDeployWithPK.ts` | the deploy wrapper: key handling, then `hardhat deploy` |
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
import { parseUnits } from "viem";
import { useAccount } from "wagmi";
import { useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-hbar";

export const MintOne = () => {
  const { address } = useAccount();
  const [failure, setFailure] = useState<string>();
  const { data: balance } = useScaffoldReadContract({
    contractName: "HederaToken",
    functionName: "balanceOf",
    args: [address],
  });
  const { writeContractAsync, isPending } = useScaffoldWriteContract({ contractName: "HederaToken" });

  const mint = async () => {
    if (!address) return;
    setFailure(undefined);
    try {
      // HederaToken keeps the ERC-20 default of 18 decimals; mint is onlyOwner.
      await writeContractAsync({ functionName: "mint", args: [address, parseUnits("1", 18)] });
    } catch (error: unknown) {
      // The transactor has already shown a notification; keep the reason next to the button too.
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p>Balance: {balance?.toString() ?? "unknown"}</p>
      <button className="btn btn-primary" disabled={!address || isPending} onClick={mint}>
        Mint 1 HTK
      </button>
      {failure && <p className="text-error">{failure}</p>}
    </div>
  );
};
```

UI components come from `@scaffold-hbar-ui/components`: `Address`, `Balance`, `HederaAddressInput`, `HbarInput`, `HederaPortalFaucet`. It has no `AddressInput` or `EtherInput`, names that other Scaffold-ETH 2 guides use. Prefer DaisyUI classes (`btn`, `card`, `text-error`) to raw Tailwind when one exists. Imports inside the app use the `~~` alias. A page that uses hooks starts with `"use client"`.

## Testing

- `yarn test` runs `packages/hardhat/test/*.test.ts` against an in-process fork of Hedera testnet read through hashio, where `@hashgraph/system-contracts-forking` emulates the token service at `0x167`. The forking worker binds port 10001, so two runs cannot share a machine.
- The tooling tests use `node:test` and need no network: `tools/checks/test/`, `tools/gate/routes.test.mjs` (both in `yarn check:tools`) and `tools/route-probe/test/` (`yarn probe:routes:check`). Tests sit next to the tool they cover.
- `yarn test:unit` runs Vitest on `packages/nextjs/lib/hedera/__tests__/` and `packages/nextjs/services/hedera/__tests__/`. The fixtures are answers captured from Hedera testnet and replayed through viem's own transport, so the error objects are those viem 2.39.0 builds; `packages/nextjs/lib/hedera/__tests__/fixtures/README.md` says where each came from. No network, no key, a few seconds.
- `yarn check:live` runs the files of `packages/nextjs/lib/hedera/__live__/` that end in .live.ts, through `packages/nextjs/vitest.live.config.ts`: keyless reads of Hedera testnet (the address book against the router, the factory and the token facades; a quote; the dated observation that three simulators accept a SAUCE to HBAR swap with no allowance) and `yarn evidence:check`. A failure there can be hashio's or the mirror node's: run it again before you debug. `.github/workflows/gate.yml` runs it nightly, never blocking.
- `yarn evidence` runs `packages/nextjs/lib/hedera/__live__/swaps.signed.ts` through `packages/nextjs/vitest.evidence.config.ts`. It signs with `__RUNTIME_DEPLOYER_PRIVATE_KEY` from the shell, writes one file per scenario to `docs/evidence/`, and is skipped, exit 0, when the variable is not set. A new scenario re-checks its record with `checkEvidence` before writing it, as the two existing ones do.
- The files of `docs/evidence/` are produced by `yarn evidence` only: never write or edit one by hand. `yarn evidence:check` fails on any figure that differs from the mirror node.
- Pages and components have no unit tests. `yarn probe:routes` is their check: each page route, three network modes, zero console errors, zero third-party requests. A new page is probed without any change; a new dynamic route needs a sample in `tools/route-probe/probe.config.json`.
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
