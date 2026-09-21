#!/usr/bin/env bash
# Negative control. Runs the scaffolding command exactly as the bounty brief prints it (the "create" initializer
# with --template and no "--" separator) under whatever npm is on PATH, and records how it ends. Seen so far:
#   npm 10  drops --template silently; the CLI starts without a template and stops at its first prompt (no TTY)
#   npm 11  the same, after warning that the flag will stop working
#   npm 12  refuses the unknown flag before the CLI starts
# None of these endings reaches a community template, which is why the docs never show this form.
# The script records and never judges: exit 0 unless it could not run at all.
#
# usage: literal-command-control.sh --template <owner/repo[#ref]>
set -uo pipefail

TEMPLATE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --template) TEMPLATE=${2-}; shift 2 ;;
    *) echo "usage: $(basename "$0") --template <owner/repo[#ref]>" >&2; exit 2 ;;
  esac
done
if [ -z "$TEMPLATE" ]; then echo "usage: $(basename "$0") --template <owner/repo[#ref]>" >&2; exit 2; fi

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/literal-command-XXXXXX") || exit 1
trap 'rm -rf "$WORK_DIR"' EXIT
LOG="$WORK_DIR/output.log"
mkdir "$WORK_DIR/cwd"
cd "$WORK_DIR/cwd" || exit 1

NPM_VERSION=$(npm --version) || exit 1
echo "node $(node --version), npm $NPM_VERSION, CI=${CI-<unset>}"
echo "command: npm create scaffold-hbar@latest --template $TEMPLATE"

MSYS_NO_PATHCONV=1 timeout 900 npm create scaffold-hbar@latest --template "$TEMPLATE" > "$LOG" 2>&1 < /dev/null
RC=$?

if grep -q 'EUNKNOWNCONFIG' "$LOG"; then
  ENDING="refused by npm before the CLI started (unknown flag)"
elif grep -q 'ERR_TTY_INIT_FAILED' "$LOG"; then
  ENDING="the CLI started without the template and stopped at its first prompt (no TTY)"
elif grep -q 'Congratulations!' "$LOG"; then
  ENDING="UNEXPECTED: a project was scaffolded; check which template it used before trusting this form"
else
  ENDING="unclassified: read the output below"
fi
if grep -q 'will stop working in the next major version' "$LOG"; then WARNED="yes"; else WARNED="no"; fi

echo "exit code: $RC"
echo "ending: $ENDING"
echo "npm warned about the flag: $WARNED"
echo "left on disk:"
find . -maxdepth 2 -not -path '*/node_modules*' -not -path '*/.git/*' | sed 's/^/  /'
echo "last lines of the output:"
tail -n 40 "$LOG" | sed 's/^/  | /'

if [ -n "${GITHUB_STEP_SUMMARY-}" ]; then
  {
    echo "### The brief's literal command under npm $NPM_VERSION"
    echo
    echo "| npm | node | exit | npm warned | ending |"
    echo "|---|---|---|---|---|"
    echo "| $NPM_VERSION | $(node --version) | $RC | $WARNED | $ENDING |"
    echo
  } >> "$GITHUB_STEP_SUMMARY"
fi
exit 0
