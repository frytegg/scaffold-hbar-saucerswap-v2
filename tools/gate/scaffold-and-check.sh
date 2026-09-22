#!/usr/bin/env bash
# Scaffolds a project from a template through the published create-scaffold-hbar CLI, the way a judge would,
# then checks what came out: the CLI's exit code and output, the git state, the shape of the tree, the root
# scripts, and a production boot with no env file where every route of the build is requested once.
# One log file and one exit code per step, a summary table at the end, exit 1 if any blocking step failed.
# Runs on ubuntu runners and on Windows Git Bash (bash 4.4 or newer). README.md next to this file has the details.
# The step_* functions are called by name through run_step, which ShellCheck cannot follow.
# shellcheck disable=SC2317
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI_PACKAGE="create-scaffold-hbar@latest"
CLI_DEFAULT_PROJECT="my-hedera-dapp"
SEAM_CARRIER_TEMPLATE="blank"
APP_NAME="gateapp"
NEXT_DIR="packages/nextjs/.next"
# Every variable read by the copy of ci-info that Yarn 3.2.3 bundles (.yarn/releases/yarn-3.2.3.cjs). Yarn runs in CI
# mode, where installs are immutable, as soon as one of CI, CONTINUOUS_INTEGRATION, BUILD_NUMBER and RUN_ID is set, or
# all the variables that identify one CI vendor: on GitHub, GITHUB_ACTIONS alone is enough.
CI_VARIABLES=(
  CI CONTINUOUS_INTEGRATION BUILD_NUMBER RUN_ID
  APPVEYOR SYSTEM_TEAMFOUNDATIONCOLLECTIONURI AC_APPCIRCLE bamboo_planKey BITBUCKET_COMMIT BITRISE_IO BUDDY_WORKSPACE_ID
  BUILDKITE CIRCLECI CIRRUS_CI CODEBUILD_BUILD_ARN CF_BUILD_ID CI_NAME DRONE DSARI GITHUB_ACTIONS GITLAB_CI
  GO_PIPELINE_LABEL LAYERCI HUDSON_URL JENKINS_URL BUILD_ID MAGNUM NETLIFY NEVERCODE RENDER SAILCI SEMAPHORE SCREWDRIVER
  SHIPPABLE TDDIUM STRIDER TASK_ID TEAMCITY_VERSION TRAVIS NOW_BUILDER APPCENTER_BUILD_ID
)

TEMPLATE=""
TEMPLATE_DIR=""
PACKAGE_MANAGER=""
FRAMEWORK=""
SKILLS="off"
PROMPTS="yes"
DIRECTORY_ARGUMENT=1
WITHOUT_CI_VARIABLES=0
PORT=3103
ROOT_SCRIPTS="lint:strict typecheck build test"
SERVE_SCRIPT="serve"
WORK_DIR=""
KEEP=0
ROUTES=()
SOFT_STEPS=()

usage() {
  cat >&2 <<'USAGE'
usage: scaffold-and-check.sh (--template <owner/repo[#ref]> | --template-dir <dir>) [options]

  --template <spec>            template fetched from GitHub by the CLI (the judges' path)
  --template-dir <dir>         local template tree, handed to the CLI through CREATE_SCAFFOLD_HBAR_TEMPLATE_DIR;
                               needs --solidity-framework, because the seam replaces the download only
  --package-manager <name>     passed to the CLI; leave it out to let the template's default decide
  --solidity-framework <name>  passed to the CLI as -s; leave it out for the "no -s" leg
  --skills <on|off>            Hedera Skills marketplace install (default: off)
  --prompts <yes|ci|flags>     --yes (default), --ci, or neither with every choice passed as a flag
  --no-directory               pass no directory argument (the CLI then uses its default project name)
  --without-ci-variables       remove every variable of Yarn's CI detection (CI, GITHUB_ACTIONS and the others of its
                               list) from the environment of the CLI and of every check, as on a developer machine
  --port <n>                   port of the production boot (default: 3103)
  --route <path>               extra concrete route to request, query string included (repeatable)
  --root-scripts "<a b c>"     root scripts to run, in order (default: "lint:strict typecheck build test")
  --serve-script <name>        root script that starts the production server (default: serve)
  --soft <step>                a failure of this step is reported but does not fail the run (repeatable)
  --work-dir <dir>             where the project and the logs go (default: a new temporary directory)
  --keep                       keep node_modules and build output afterwards (later steps can reuse them)
USAGE
  exit 2
}

die() {
  echo "error: $*" >&2
  exit 2
}

# Native programs on Git Bash need C:/ paths; on Linux the path is returned as it is.
native_path() {
  if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}

# The CI_VARIABLES that are set to a non-empty value, which is what ci-info tests, comma-separated; "none" if none.
set_ci_variables() {
  local name found=()
  for name in "${CI_VARIABLES[@]}"; do
    if [ -n "${!name-}" ]; then found+=("$name"); fi
  done
  local IFS=,
  echo "${found[*]:-none}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --template) TEMPLATE=${2-}; shift 2 ;;
    --template-dir) TEMPLATE_DIR=${2-}; shift 2 ;;
    --package-manager) PACKAGE_MANAGER=${2-}; shift 2 ;;
    --solidity-framework) FRAMEWORK=${2-}; shift 2 ;;
    --skills) SKILLS=${2-}; shift 2 ;;
    --prompts) PROMPTS=${2-}; shift 2 ;;
    --no-directory) DIRECTORY_ARGUMENT=0; shift ;;
    --without-ci-variables) WITHOUT_CI_VARIABLES=1; shift ;;
    --port) PORT=${2-}; shift 2 ;;
    --route) ROUTES+=("${2-}"); shift 2 ;;
    --root-scripts) ROOT_SCRIPTS=${2-}; shift 2 ;;
    --serve-script) SERVE_SCRIPT=${2-}; shift 2 ;;
    --soft) SOFT_STEPS+=("${2-}"); shift 2 ;;
    --work-dir) WORK_DIR=${2-}; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h | --help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

if [ -n "$TEMPLATE" ] && [ -n "$TEMPLATE_DIR" ]; then die "--template and --template-dir exclude each other"; fi
if [ -z "$TEMPLATE" ] && [ -z "$TEMPLATE_DIR" ]; then usage; fi
case "$SKILLS" in on | off) ;; *) die "--skills takes on or off" ;; esac
case "$PROMPTS" in yes | ci | flags) ;; *) die "--prompts takes yes, ci or flags" ;; esac
case "$PACKAGE_MANAGER" in "" | yarn | npm) ;; *) die "--package-manager takes yarn or npm" ;; esac

if [ -n "$TEMPLATE_DIR" ]; then
  [ -f "$TEMPLATE_DIR/template.json" ] || die "$TEMPLATE_DIR has no template.json: not a template tree"
  # With the seam the CLI still takes its capabilities from the built-in entry named by --template, whose default
  # framework is Foundry: without -s it would delete packages/hardhat and ask for forge.
  [ -n "$FRAMEWORK" ] || die "--template-dir needs --solidity-framework"
  TEMPLATE_DIR=$(realpath "$TEMPLATE_DIR")
fi

if [ -z "$WORK_DIR" ]; then WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/gate-XXXXXX"); fi
WORK_DIR=$(realpath -m "$WORK_DIR")
case "$WORK_DIR/" in
  "${TEMPLATE_DIR:-/nonexistent}/"*) die "--work-dir must be outside the template tree (the CLI would copy the project into itself)" ;;
esac
mkdir -p "$WORK_DIR" || die "cannot create $WORK_DIR"

if [ "$DIRECTORY_ARGUMENT" = 1 ]; then APP_DIR="$WORK_DIR/$APP_NAME"; else APP_DIR="$WORK_DIR/$CLI_DEFAULT_PROJECT"; fi
[ ! -e "$APP_DIR" ] || die "$APP_DIR already exists: the CLI refuses to scaffold into it"
LOG_DIR="$WORK_DIR/logs"
mkdir -p "$LOG_DIR"
SUMMARY_TSV="$LOG_DIR/summary.tsv"
: > "$SUMMARY_TSV"

# Annotations are for the runner, so this is read before --without-ci-variables removes GITHUB_ACTIONS.
ANNOTATE=0
if [ -n "${GITHUB_ACTIONS-}" ]; then ANNOTATE=1; fi
HOST_CI_VARIABLES=$(set_ci_variables)
if [ "$WITHOUT_CI_VARIABLES" = 1 ]; then unset "${CI_VARIABLES[@]}"; fi
RUN_CI_VARIABLES=$(set_ci_variables)
export NEXT_TELEMETRY_DISABLED=1 npm_config_update_notifier=false

STEP_INDEX=0
FAILED=0
LAST_STATUS=""
LAST_LOG=""

is_soft() {
  local step
  for step in "${SOFT_STEPS[@]}"; do
    if [ "$step" = "$1" ]; then return 0; fi
  done
  return 1
}

record() { # record <step> <status> <exit> <seconds> <log>
  printf '%s\t%s\t%s\t%s\t%s\n' "$@" >> "$SUMMARY_TSV"
  LAST_STATUS=$2
}

# run_step <step> <timeout-seconds, 0 for a shell function> <command...>
run_step() {
  local step=$1 limit=$2
  shift 2
  STEP_INDEX=$((STEP_INDEX + 1))
  local log
  log="$LOG_DIR/$(printf '%02d' "$STEP_INDEX")-${step//:/-}.log"
  local started=$SECONDS rc status
  {
    echo "### $(date -u +%FT%TZ) step=$step cwd=$PWD ci-variables=$RUN_CI_VARIABLES"
    echo "### command: $*"
  } > "$log"
  if [ "$limit" = 0 ]; then
    "$@" >> "$log" 2>&1 < /dev/null
  else
    timeout "$limit" "$@" >> "$log" 2>&1 < /dev/null
  fi
  rc=$?
  echo "### exit=$rc seconds=$((SECONDS - started))" >> "$log"
  if [ "$rc" = 0 ]; then
    status="pass"
  elif is_soft "$step"; then
    status="soft-fail"
  else
    status="FAIL"
    FAILED=1
  fi
  record "$step" "$status" "$rc" "$((SECONDS - started))" "${log#"$WORK_DIR"/}"
  LAST_LOG=$log
  echo "[$status] $step (exit $rc, $((SECONDS - started)) s)"
  if [ "$status" != "pass" ]; then tail -n 30 "$log" | sed 's/^/    | /'; fi
  if [ "$status" = "soft-fail" ] && [ "$ANNOTATE" = 1 ]; then
    echo "::warning title=non-blocking gate step failed::$step exited $rc; it is listed in the job summary"
  fi
}

skip_step() { # skip_step <step> <reason>
  record "$1" "skipped" "-" "-" "$2"
  echo "[skipped] $1: $2"
}

step_rate_limit() {
  local body
  if ! body=$(curl -sS -m 30 https://api.github.com/rate_limit); then
    echo "rate_limit unreadable (curl failed): attribution of a failed scaffold is not possible from this run"
    return 0
  fi
  # JavaScript source: ${...} is a template literal, not a shell expansion.
  # shellcheck disable=SC2016
  printf '%s' "$body" | node -e '
    let text = "";
    process.stdin.on("data", chunk => (text += chunk)).on("end", () => {
      try {
        const core = JSON.parse(text).resources.core;
        console.log(`github unauthenticated core quota: remaining=${core.remaining}/${core.limit} reset=${new Date(core.reset * 1000).toISOString()}`);
      } catch (error) {
        console.log(`rate_limit unreadable: ${error.message}`);
      }
    });'
}

step_environment() {
  echo "os: $(uname -srm)"
  echo "node: $(node --version)"
  echo "npm: $(npm --version)"
  echo "yarn on PATH: $(cd "$WORK_DIR" && yarn --version 2>&1 | head -n 1)"
  echo "git: $(git --version)"
  echo "forge: $(command -v forge || echo absent)"
  echo "CI variables set by the host: $HOST_CI_VARIABLES"
  echo "CI variables that the CLI and the checks see: $RUN_CI_VARIABLES"
  echo "published CLI: $(npm view create-scaffold-hbar version 2>&1 | tail -n 1)"
  if has_git_identity; then
    echo "git identity: configured"
  else
    echo "git identity: none, so a throwaway one is set for this run only (the CLI refuses to start without one)"
  fi
}

has_git_identity() {
  git config user.name > /dev/null && git config user.email > /dev/null
}

# A runner has no git identity and the CLI stops without one. GIT_CONFIG_* reaches the CLI's own git calls and
# leaves the machine's configuration alone.
ensure_git_identity() {
  if has_git_identity; then return 0; fi
  export GIT_CONFIG_COUNT=2
  export GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0="template gate"
  export GIT_CONFIG_KEY_1=user.email GIT_CONFIG_VALUE_1="template-gate@users.noreply.github.com"
}

build_cli_arguments() {
  CLI_ARGUMENTS=()
  if [ "$DIRECTORY_ARGUMENT" = 1 ]; then CLI_ARGUMENTS+=("$APP_NAME"); fi
  if [ -n "$TEMPLATE_DIR" ]; then
    CLI_ARGUMENTS+=(--template "$SEAM_CARRIER_TEMPLATE")
  else
    CLI_ARGUMENTS+=(--template "$TEMPLATE")
  fi
  if [ -n "$FRAMEWORK" ]; then CLI_ARGUMENTS+=(-s "$FRAMEWORK"); fi
  local manager=$PACKAGE_MANAGER
  case "$PROMPTS" in
    yes) CLI_ARGUMENTS+=(--yes) ;;
    ci) CLI_ARGUMENTS+=(--ci) ;;
    flags)
      # No TTY on a runner: every prompt that is still open has to be answered by a flag.
      CLI_ARGUMENTS+=(--frontend nextjs-app --network testnet)
      manager=${manager:-yarn}
      if [ "$SKILLS" = on ]; then CLI_ARGUMENTS+=(--install-hedera-skills); fi
      ;;
  esac
  if [ "$SKILLS" = off ]; then CLI_ARGUMENTS+=(--skip-hedera-skills); fi
  if [ -n "$manager" ]; then CLI_ARGUMENTS+=(--package-manager "$manager"); fi
}

step_scaffold_output() {
  local log=$1 rc=0 marker
  if grep -q 'Congratulations!' "$log"; then
    echo "ok: the CLI printed its Congratulations line"
  else
    echo "MISSING: the CLI's Congratulations line"
    rc=1
  fi
  for marker in 'Format step failed' 'YN0028' 'requirements not met'; do
    if grep -q "$marker" "$log"; then
      echo "FOUND in the CLI output: $marker"
      rc=1
    fi
  done
  return "$rc"
}

step_git_state() {
  local rc=0 branch commits dirty
  branch=$(git branch --show-current)
  commits=$(git rev-list --count HEAD)
  dirty=$(git status --porcelain)
  echo "branch=$branch commits=$commits head=$(git log -1 --format='%h %s')"
  if [ "$branch" != "main" ]; then echo "EXPECTED branch main"; rc=1; fi
  if [ "$commits" != "1" ]; then echo "EXPECTED exactly one commit"; rc=1; fi
  if [ -n "$dirty" ]; then echo "EXPECTED a clean working tree, got:"; echo "$dirty"; rc=1; fi
  return "$rc"
}

step_tree_shape() {
  local rc=0 found pinned
  if [ -e template.json ]; then echo "template.json is still present (the CLI deletes it after a valid parse)"; rc=1; fi
  if [ ! -d packages/hardhat ]; then echo "packages/hardhat is missing"; rc=1; fi
  if [ -e packages/foundry ]; then echo "packages/foundry is present"; rc=1; fi
  found=$(git ls-files -s | awk '$1 == 120000 { print $4 }')
  if [ -n "$found" ] && [ "$SKILLS" = on ]; then
    echo "tracked symlinks (not judged: the skills install adds its own files to the first commit):"
    echo "$found"
  elif [ -n "$found" ]; then
    echo "tracked symlinks, which a Windows checkout cannot materialise:"
    echo "$found"
    rc=1
  fi
  found=$(find . -name '.env*' ! -name '.env.example' -not -path '*/node_modules/*' -not -path './.git/*')
  if [ -n "$found" ]; then echo "env files that a fresh scaffold must not have:"; echo "$found"; rc=1; fi
  pinned=$(project_pin)
  echo "packageManager=$pinned"
  if [ -n "$PACKAGE_MANAGER" ] && [ "${pinned%%@*}" != "$PACKAGE_MANAGER" ]; then
    echo "EXPECTED a project pinned to $PACKAGE_MANAGER"
    rc=1
  fi
  # A lockfile that the CLI's install had to change is refused where CI mode makes installs immutable.
  if [ -n "$TEMPLATE_DIR" ] && [ -f yarn.lock ]; then
    if cmp -s "$TEMPLATE_DIR/yarn.lock" yarn.lock; then
      echo "ok: the lockfile is byte-identical to the template's"
    else
      echo "the lockfile differs from the template's: the template's lockfile does not match its workspaces"
      rc=1
    fi
  fi
  if [ "$rc" = 0 ]; then echo "ok: tree shape"; fi
  return "$rc"
}

step_tree_still_clean() {
  local dirty
  dirty=$(git status --porcelain)
  if [ -z "$dirty" ]; then echo "ok: no root script modified a tracked file"; return 0; fi
  echo "tracked files changed by the root scripts:"
  echo "$dirty"
  return 1
}

# The packageManager field of the scaffolded project; empty when there is no project or no field.
project_pin() {
  if [ -f "$APP_DIR/package.json" ]; then
    node -p 'String(require(process.argv[1]).packageManager ?? "")' "$(native_path "$APP_DIR/package.json")"
  fi
}

# Asked in the project, the Yarn that installed it reports its CI detection as the default of enableImmutableInstalls
# and what the install did as the effective value.
step_ci_detection() {
  local output line detected effective
  output=$(cd "$APP_DIR" && timeout 300 yarn config --why --json 2>&1)
  if ! line=$(grep '"key":"enableImmutableInstalls"' <<< "$output"); then
    echo "Yarn did not report enableImmutableInstalls. Its output:"
    echo "$output"
    return 1
  fi
  echo "$line"
  detected=$(grep -o '"default":[a-z]*' <<< "$line")
  detected=${detected#*:}
  effective=$(grep -o '"effective":[a-z]*' <<< "$line")
  echo "Yarn detects CI: $detected; immutable installs: ${effective#*:}"
  case "$detected" in
    false) echo "ok: Yarn runs as on a developer machine" ;;
    true)
      if [ "$WITHOUT_CI_VARIABLES" = 1 ]; then
        echo "Yarn still detects CI with every variable of CI_VARIABLES removed: it reads one that the list lacks"
        return 1
      fi
      echo "ok: Yarn runs in CI mode, as the host sets it"
      ;;
    *) echo "cannot read Yarn's CI detection from that line"; return 1 ;;
  esac
}

report_ci_detection() {
  local pinned
  pinned=$(project_pin)
  case "${pinned%%@*}" in
    yarn) run_step ci-detection 0 step_ci_detection ;;
    "") skip_step ci-detection "no project, or no packageManager field, to say which package manager installed it" ;;
    *) skip_step ci-detection "the project is pinned to $pinned: only Yarn's CI detection is read" ;;
  esac
}

step_project_created() {
  if [ -d "$APP_DIR" ]; then echo "ok: $APP_DIR"; return 0; fi
  echo "the CLI exited 0 but $APP_DIR does not exist (it falls back to $CLI_DEFAULT_PROJECT when a name is invalid)"
  return 1
}

step_boot() {
  if [ ! -f "$NEXT_DIR/BUILD_ID" ]; then
    echo "no production build at $NEXT_DIR/BUILD_ID: nothing to boot"
    return 1
  fi
  local arguments=(--port "$PORT" --next-dir "$NEXT_DIR" --server-log "$(native_path "$LOG_DIR/server.log")")
  local route
  for route in "${ROUTES[@]}"; do arguments+=(--route "$route"); done
  MSYS_NO_PATHCONV=1 node "$(native_path "$HERE/boot-check.mjs")" "${arguments[@]}" -- \
    "$(native_path "$BASH")" "$(native_path "$HERE/run-root-script.sh")" . "$SERVE_SCRIPT"
}

step_cleanup() {
  rm -rf node_modules packages/*/node_modules "$NEXT_DIR" .yarn/cache packages/hardhat/artifacts \
    packages/hardhat/cache packages/hardhat/typechain-types
  echo "removed the dependency trees and the build output of $APP_DIR; sources and logs stay"
}

print_summary() {
  local title=$1 step status code seconds log
  echo
  echo "== $title"
  echo "== logs are relative to $WORK_DIR"
  printf '%-24s %-10s %-5s %-8s %s\n' step status exit seconds log
  while IFS=$'\t' read -r step status code seconds log; do
    printf '%-24s %-10s %-5s %-8s %s\n' "$step" "$status" "$code" "$seconds" "$log"
  done < "$SUMMARY_TSV"
  if [ -n "${GITHUB_STEP_SUMMARY-}" ]; then
    {
      echo "### $title"
      echo
      echo "| step | status | exit | seconds |"
      echo "|---|---|---|---|"
      while IFS=$'\t' read -r step status code seconds log; do
        echo "| $step | $status | $code | $seconds |"
      done < "$SUMMARY_TSV"
      echo
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

# ---------------------------------------------------------------- run
build_cli_arguments
TITLE="scaffold gate: ${TEMPLATE:-local tree $(basename "$TEMPLATE_DIR")} [${CLI_ARGUMENTS[*]}] ci-variables=$RUN_CI_VARIABLES node=$(node --version)"
echo "$TITLE"
echo "work dir: $WORK_DIR"
cd "$WORK_DIR" || die "cannot enter $WORK_DIR"

run_step rate-limit 0 step_rate_limit
grep -v '^###' "$LAST_LOG"
run_step environment 0 step_environment
ensure_git_identity

# The --ci flag and the optional directory argument are only exercised while the CLI's own help lists them.
NOT_APPLICABLE=""
if [ "$PROMPTS" = ci ] || [ "$DIRECTORY_ARGUMENT" = 0 ]; then
  run_step cli-help 300 npx "$CLI_PACKAGE" --help
  if [ "$PROMPTS" = ci ] && ! grep -q -- '--ci' "$LAST_LOG"; then NOT_APPLICABLE="the CLI's help does not list --ci"; fi
  if [ "$DIRECTORY_ARGUMENT" = 0 ] && ! grep -qF -- '[project-name]' "$LAST_LOG"; then
    NOT_APPLICABLE="the CLI's help does not show the directory argument as optional"
  fi
fi

run_checks() {
  local scaffold_log=$1 script
  run_step project-created 0 step_project_created
  if [ "$LAST_STATUS" != "pass" ]; then return; fi
  run_step scaffold-output 0 step_scaffold_output "$scaffold_log"
  cd "$APP_DIR" || die "cannot enter $APP_DIR"
  run_step git-state 0 step_git_state
  run_step tree-shape 0 step_tree_shape
  for script in $ROOT_SCRIPTS; do
    run_step "$script" 1800 bash "$HERE/run-root-script.sh" . "$script"
  done
  run_step tree-still-clean 0 step_tree_still_clean
  # A run whose root scripts do not build the project has nothing to boot, and that is not a finding: step_boot's
  # missing-build failure stays for the runs that did ask for a build and got no output.
  case " $ROOT_SCRIPTS " in
    *" build "*) run_step boot 0 step_boot ;;
    *) skip_step boot "build is not among this run's root scripts" ;;
  esac
  if [ "$KEEP" = 0 ]; then run_step cleanup 0 step_cleanup; fi
}

if [ -n "$NOT_APPLICABLE" ]; then
  skip_step scaffold "$NOT_APPLICABLE"
else
  SCAFFOLD_ENV=(MSYS_NO_PATHCONV=1)
  if [ -n "$TEMPLATE_DIR" ]; then SCAFFOLD_ENV+=("CREATE_SCAFFOLD_HBAR_TEMPLATE_DIR=$(native_path "$TEMPLATE_DIR")"); fi
  run_step scaffold 2400 env "${SCAFFOLD_ENV[@]}" npx "$CLI_PACKAGE" "${CLI_ARGUMENTS[@]}"
  SCAFFOLD_STATUS=$LAST_STATUS
  SCAFFOLD_LOG=$LAST_LOG
  run_step rate-limit-after 0 step_rate_limit
  # Also after a failed scaffold: the mode Yarn was in is what tells an immutable-lockfile refusal apart.
  report_ci_detection
  if [ "$SCAFFOLD_STATUS" = "pass" ]; then
    run_checks "$SCAFFOLD_LOG"
  else
    # The CLI reads the template's manifest from the GitHub API without a token. When that read is rate-limited
    # it silently falls back to its own defaults (Foundry), which is not a failure of the template.
    if grep -hq 'remaining=0/' "$LOG_DIR"/*rate-limit*.log; then
      echo "NOT ATTRIBUTABLE: the unauthenticated GitHub quota of this machine is exhausted; run this leg again"
    fi
    skip_step checks "the scaffold failed, there is no project to check"
  fi
fi

print_summary "$TITLE"
exit "$FAILED"
