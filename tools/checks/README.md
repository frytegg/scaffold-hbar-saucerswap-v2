# Repository checks

Nine checks that compare what the docs and the template manifest say with what the repository holds, and one runner.
They are plain Node ESM modules whose JSDoc types `tsc` checks in strict mode through `tools/checks/tsconfig.json`: `node` alone runs them on Node 20.18.3, before any install or build, and they add no dependency.

## Run

```bash
node tools/checks/run-all.mjs
node tools/checks/run-all.mjs --allow-offline
node tools/checks/check-paths.mjs --repo ../another-checkout
node tools/checks/run-tests.mjs
```

From the repository root, `yarn check:docs` runs the nine checks, and `yarn check:tools` runs their tests with the other tools' checks.
The runner prints the findings of each check that did not pass, then one table.
Exit codes are the same for every command: 0 when the check passes or has nothing to judge, 1 when it has findings, 2 when it reached no verdict (registry unreachable, dependencies not installed, shallow clone, or a published CLI whose code no longer matches what the checks cut out of it).

## What each check refuses

The docs are every README.md and AGENTS.md of the repository, these tool READMEs included, and the Markdown files under a top-level docs folder. Every other text file is covered by `check-rewrite.mjs`.

| Check | Refuses |
| --- | --- |
| `check-paths.mjs` | a path in backticks, or an entry of a drawn directory tree, that git does not track unless the ignore rules explain its absence; a reference to a file the CLI deletes from scaffolds |
| `check-scripts.mjs` | a documented command or a manifest placeholder that names no root script, or, after npm's `--prefix <dir>`, no script of the package in that directory; a documented command with a flag; a flag after a placeholder; an outro command that runs bare a script the docs show with arguments |
| `check-symbols.mjs` | a code identifier in backticks that is neither in the tracked source nor exported by a dependency named on the same line |
| `check-snippets.mjs` | a TypeScript fence that does not type-check inside `packages/nextjs`, or inside the workspace its info string names |
| `check-env.mjs` | a variable that the code, the `.env.example` files, the docs and the manifest do not all know; a variable called required although the code has a default for it |
| `check-rewrite.mjs` | any line that the CLI's npm-mode rewrite turns into something other than a clean script conversion; a changed line count; a converted command that keeps a flag; any change to a source file |
| `check-manifest.mjs` | a template manifest that the CLI's schema rejects or silently trims, as committed and after the rewrite |
| `check-vocab.mjs` | wording the Hedera docs avoid; a package manager named anywhere but in an exact script command |
| `check-hygiene.mjs` | a tracked dotenv file, now or in any commit of any ref; a symbolic link; a file over 1 MB other than a lockfile; configuration of AI tools outside the hosts' kit; a licence that is not the unmodified MIT text with the upstream notices |

`check-rewrite.mjs` and `check-manifest.mjs` download the latest published `create-scaffold-hbar`, and the zod version it installs with, from the registry on every run. Each tarball is verified against the registry's digest and cached under `scaffold-hbar-checks` in the OS temp directory. The checks then evaluate the rewrite functions and the manifest schema cut out of the CLI's bundle; when the anchor lines of those pieces are gone, they stop with exit 2 and name the missing anchor.
Without network access both checks end with exit 2. With `--allow-offline` they fall back to the newest cached copies, or skip loudly when there are none.

## Requirements

- `check-symbols.mjs` and `check-snippets.mjs` load TypeScript from the workspace they inspect: install the dependencies first.
- `check-hygiene.mjs` walks the whole history. In GitHub Actions, check out with `fetch-depth: 0`.
- The hosts' agent kit (`.agents/`, `.claude/`), what the skills step adds to it (`agent/`, `skills-lock.json`) and the vendored package-manager release are not judged, except for dotenv files and personal tool settings.

<!-- checks:allow
paths: agent skills-lock.json
-->

## Deliberate exceptions

A doc that has to name something absent declares it in an HTML comment, one kind per line:

```markdown
<!-- checks:allow
symbols: useScaffoldContractRead
paths: templates/blank-template
-->
```

An entry that excuses nothing is itself a finding, so the block cannot go stale.

## Limits

- A symbol passes when the word occurs anywhere in the tracked source: the check finds names that do not exist, not names used in the wrong place.
- A drawn tree loses the parent of each entry, so an entry passes when any tracked path holds that name.
- Environment reads are recognised as `process.env.NAME`, `process.env["NAME"]` and `process.env[CONSTANT]` where the constant is a string declared in the code. Destructured reads are not seen.
- Whether a script needs an argument is not decidable from `package.json`; the check compares the outro with the way the docs show the same script.
- The rewrite is replayed on the files as committed. A scaffold made in npm-mode has nothing left to convert, so the check proves something on the template and on scaffolds made with the default package manager.

## Tests

`node tools/checks/run-tests.mjs` runs the `node:test` suites in `test/` without network. Fixtures that name a package manager are stored as `*.markdown`, an extension the rewrite leaves alone.
The `*.after.markdown` fixtures are the output of the rewrite function of `create-scaffold-hbar` 0.4.0 on the matching `*.before.markdown` files.
