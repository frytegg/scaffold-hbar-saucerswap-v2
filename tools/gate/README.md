# Scaffold gate

Checks that this template still scaffolds through the published `create-scaffold-hbar` CLI, and that the project it produces lints, type-checks, builds and boots with no configuration. Nothing here depends on what the template is about.

## Files

| file | role |
| --- | --- |
| `scaffold-and-check.sh` | one gate leg: scaffold, assert, run the root scripts, boot, print a summary table |
| `local.sh` | one leg on your machine against the committed HEAD (exported with `git archive`, never the working tree); the root script `gate:local` runs it |
| `run-root-script.sh` | runs one root script of a project with the package manager that project was scaffolded for; a script that is not defined is exit 3, never a skip |
| `boot-check.mjs`, `routes.mjs` | boots the production server on a given port with no env file and requests every route of the build once |
| `routes.test.mjs` | tests of the route rules: `node --test tools/gate/routes.test.mjs` |
| `tsconfig.json` | strict type-check of the three JavaScript modules above; `check:tools` runs it with the tests |
| `secret-scan.sh` | tracked env files, then gitleaks over the whole history and over an export of HEAD, with the root `.gitleaks.toml` |
| `literal-command-control.sh` | negative control: records how the scaffolding command ends when it is typed exactly as the bounty brief prints it |

## One leg

```bash
# the committed HEAD of this checkout, through the CLI's local-template seam (works for a private repository)
bash tools/gate/local.sh --work-dir ../gate-work

# a published template, through the path a judge uses
bash tools/gate/scaffold-and-check.sh --template owner/repo --work-dir ../gate-work
```

`--template-dir` takes a clean template tree such as a fresh checkout: apart from git's own folder, `node_modules`, the Next.js build output, `.env` and the package manager's cache, the seam copies every file it finds, untracked ones included. `--work-dir` has to be outside the template tree. `--help` lists every option; each one maps to a switch of the CLI (`-s`, `--yes` or `--ci`, the package manager, the skills install, the directory argument) or of the environment (`CI` unset).

With `--template-dir` the seam replaces the download only: the CLI still reads its capabilities from a built-in entry whose default framework is Foundry, so `--solidity-framework` is mandatory there. The "no `-s`" case can only be proven through `--template`, against a public repository.

Steps, in order. Each one has its own log file under `<work-dir>/logs/` and its own exit code.

| step | passes when |
| --- | --- |
| `rate-limit` | always. Prints the machine's unauthenticated GitHub quota first: the CLI reads `template.json` from the GitHub API without a token and silently falls back to its own defaults when that read is refused |
| `environment` | always. Versions, `CI`, git identity (a throwaway identity is set for the run when the machine has none, because the CLI refuses to start without one) |
| `cli-help` | only for `--prompts ci` and `--no-directory`: the leg is skipped once the CLI's help stops listing the flag |
| `scaffold` | `npx create-scaffold-hbar@latest <dir> --template <spec>` exits 0 |
| `project-created` | the directory exists (the CLI renames a project whose name it rejects and still exits 0) |
| `scaffold-output` | the Congratulations line is there; `Format step failed`, `YN0028` and `requirements not met` are not |
| `git-state` | branch `main`, exactly one commit, clean working tree |
| `tree-shape` | `template.json` deleted, `packages/hardhat` present, `packages/foundry` absent, no env file, no tracked symlink (skills off), `packageManager` pinned as requested, lockfile byte-identical to the template's (local tree only) |
| one per root script | `lint:strict`, `typecheck`, `build`, `test` by default (`--root-scripts`) |
| `tree-still-clean` | no root script modified a tracked file |
| `boot` | the production server (`--serve-script`, default `serve`) listens on `--port` (default 3103) with every `NEXT_PUBLIC_*` and `HEDERA_*` variable removed from its environment; every page answers below 400 with at least 20 characters of visible text; every route handler answers a bare GET below 500; the port is free again afterwards |
| `cleanup` | removes the dependency trees and the build output, unless `--keep` |

Routes are read from the build (`packages/nextjs/.next/app-path-routes-manifest.json`), so a new page is covered without editing a list. A dynamic page is requested once per prerendered instance; one without any instance fails the step until a concrete path is passed with `--route`. Use `--route` as well for a handler that needs a query string.

The run exits 1 when any step is `FAIL`. `--soft <step>` reports a failure as `soft-fail` without failing the run; the workflows use it for `test` only, because that script forks a public testnet endpoint. On GitHub the summary table is also written to the job summary.

## Workflows

| workflow | runs in | what |
| --- | --- | --- |
| `gate.yml` | the template repository | one leg per push through the seam; nightly on Node 20.18.3 and the current LTS, with both package managers; then the root scripts `probe:routes` and `check:docs` inside the scaffolded project, then the secret scan |
| `gate-skeleton.yml` | the public skeleton only | the judges' path against the skeleton itself: each CLI switch changed against one baseline, plus the pairs that interact; the leg without `-s` is blocking; the secret scan of the skeleton's tree and history, blocking; three recorded runs of the brief's literal command |
| `hosts-control.yml` | the public skeleton only | the same script against the hosts' blank template, to tell a failure of the base from a failure of this template; never blocking |

`CI` is left as GitHub sets it: installs are then immutable, which is what a judge running inside CI gets. No workflow uses a secret.

## On Windows Git Bash

- When a parent folder's `package.json` pins another package manager through Corepack, export `COREPACK_ENABLE_STRICT=0` first; the CLI otherwise reports that the default package manager is not installed.
- `secret-scan.sh` downloads gitleaks on Linux x64 only; elsewhere pass `--gitleaks <binary>` (release 8.30.1).
- A leg installs well over 1 GB under `--work-dir`; `cleanup` gives it back.

<!-- checks:allow
paths: <work-dir>/logs template.json packages/foundry
symbols: COREPACK_ENABLE_STRICT
-->

## Not covered here

- The interactive path (prompts answered by hand): a runner has no TTY.
- Browser console errors: that is the `probe:routes` root script.
