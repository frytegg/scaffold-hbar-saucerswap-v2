#!/usr/bin/env bash
# Runs one root package.json script of a project with the package manager that project was scaffolded for.
# A script that is not defined is a failure with its own message, so a CI step can never pass by skipping it.
#
# usage: run-root-script.sh <project-dir> <script-name>
# exit:  the script's own exit code; 2 on a usage error; 3 when the script or the package manager is unknown
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $(basename "$0") <project-dir> <script-name>" >&2
  exit 2
fi

cd "$1"
script_name=$2

# The package-manager names stay in this .sh file on purpose: the CLI's npm-mode text rewrite skips .sh files,
# so the detection below reads the same in both kinds of scaffold.
if ! manager=$(node -e '
  const fs = require("node:fs");
  const name = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (typeof pkg.scripts?.[name] !== "string") {
    console.error(`package.json in ${process.cwd()} has no root script named "${name}"`);
    process.exit(3);
  }
  const pinned = String(pkg.packageManager ?? "").split("@")[0];
  const fromLockfile = fs.existsSync("yarn.lock") ? "yarn" : fs.existsSync("package-lock.json") ? "npm" : "";
  const manager = pinned || fromLockfile;
  if (manager !== "yarn" && manager !== "npm") {
    console.error(`cannot tell the package manager of ${process.cwd()}: packageManager="${pkg.packageManager ?? ""}", no lockfile`);
    process.exit(3);
  }
  console.log(manager);
' "$script_name"); then
  exit 3
fi

case "$manager" in
  yarn) exec yarn run "$script_name" ;;
  npm) exec npm run "$script_name" ;;
esac
