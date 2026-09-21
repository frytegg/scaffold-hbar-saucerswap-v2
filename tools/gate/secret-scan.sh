#!/usr/bin/env bash
# Secret scan of this repository, tree and history:
#   1. no env file other than .env.example is tracked now or was ever added;
#   2. gitleaks over the whole history;
#   3. gitleaks over a clean export of HEAD (the tree a scaffold is copied from), so untracked local files and
#      node_modules never reach the scanner.
# Both gitleaks runs use the repository's .gitleaks.toml.
#
# usage: secret-scan.sh [--gitleaks <binary>]
#   Without --gitleaks the pinned release is downloaded and checked against its published sha256 (Linux x64 only).
# exit:  0 when every check passes, 1 otherwise, 2 on a usage error
set -uo pipefail

GITLEAKS_VERSION="8.30.1"
GITLEAKS_LINUX_X64_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
ENV_FILE='(^|/)\.env(\.[^/]+)?$'

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GITLEAKS=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --gitleaks) GITLEAKS=$(realpath "${2-}") || exit 2; shift 2 ;;
    *) echo "usage: $(basename "$0") [--gitleaks <binary>]" >&2; exit 2 ;;
  esac
done

cd "$HERE/../.." || exit 1
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/secret-scan-XXXXXX") || exit 1
trap 'rm -rf "$SCRATCH"' EXIT
FAILED=0

fail() {
  echo "FAILED: $*"
  FAILED=1
}

if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  fail "shallow clone: the history scan needs every commit (fetch-depth: 0)"
fi

tracked=$(git ls-files | grep -E "$ENV_FILE" | grep -v '\.env\.example$')
if [ -n "$tracked" ]; then fail "env files are tracked: $tracked"; else echo "ok: no env file is tracked"; fi
added=$(git log --all --diff-filter=A --name-only --format= | grep -E "$ENV_FILE" | grep -v '\.env\.example$' | sort -u)
if [ -n "$added" ]; then fail "env files were added somewhere in the history: $added"; else echo "ok: no env file in the history"; fi

if [ -z "$GITLEAKS" ]; then
  if [ "$(uname -sm)" != "Linux x86_64" ]; then
    echo "no pinned gitleaks download for $(uname -sm): pass --gitleaks <binary> (release $GITLEAKS_VERSION)" >&2
    exit 2
  fi
  archive="$SCRATCH/gitleaks.tar.gz"
  url="https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  curl -fsSL -o "$archive" "$url" || { echo "cannot download $url" >&2; exit 1; }
  echo "$GITLEAKS_LINUX_X64_SHA256  $archive" | sha256sum -c - || { echo "checksum mismatch for $url" >&2; exit 1; }
  tar -xzf "$archive" -C "$SCRATCH" gitleaks || exit 1
  GITLEAKS="$SCRATCH/gitleaks"
fi
echo "gitleaks $("$GITLEAKS" version)"

"$GITLEAKS" git --no-banner --redact --config .gitleaks.toml . || fail "gitleaks found something in the history (exit $?)"

mkdir "$SCRATCH/head"
git archive HEAD | tar -x -C "$SCRATCH/head" || fail "cannot export HEAD"
(cd "$SCRATCH/head" && "$GITLEAKS" dir --no-banner --redact --config .gitleaks.toml .) \
  || fail "gitleaks found something in the tree at HEAD (exit $?)"

exit "$FAILED"
