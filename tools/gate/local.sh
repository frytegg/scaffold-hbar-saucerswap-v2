#!/usr/bin/env bash
# One gate leg on this machine, against the committed HEAD of this repository.
# HEAD is exported with git archive, which is what GitHub serves as the repository's tarball, and the export goes
# through scaffold-and-check.sh and the CLI's local-template seam. The working tree itself is never handed to the
# CLI: the seam copies untracked files too, build output and a .env.local included.
# Arguments are passed on to scaffold-and-check.sh (--port, --work-dir, --keep, --package-manager, ...).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
HEAD_COMMIT=$(git -C "$REPO" rev-parse --short HEAD)

if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  echo "note: uncommitted changes are not part of this run, which checks HEAD $HEAD_COMMIT" >&2
fi

EXPORT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/gate-template-XXXXXX")
trap 'rm -rf "$EXPORT_DIR"' EXIT
git -C "$REPO" archive --format=tar HEAD | tar -x -C "$EXPORT_DIR"
echo "template: HEAD $HEAD_COMMIT, exported to $EXPORT_DIR" >&2

bash "$HERE/scaffold-and-check.sh" --template-dir "$EXPORT_DIR" --solidity-framework hardhat "$@"
