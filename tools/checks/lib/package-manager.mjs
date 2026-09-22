// @ts-check

/**
 * In npm-mode the CLI rewrites every text file of a scaffold, these checkers included, and replaces the default
 * package manager's name wherever it stands as a word. The name is assembled here so that the rewrite cannot
 * change what the checkers look for.
 */
export const YARN = ["ya", "rn"].join("");

const CAPITALISED = YARN[0].toUpperCase() + YARN.slice(1);

/** The two spellings the CLI replaces. Other spellings, such as all capitals, are left alone by it. */
export const YARN_WORD = new RegExp(String.raw`\b(?:${YARN}|${CAPITALISED})\b`);

/** Sub-commands that mean the same under both package managers once the CLI has converted them. */
const SHARED_BUILTINS = new Set(["install"]);

/**
 * @typedef {object} ScriptCommand
 * @property {string} script the word after the package manager
 * @property {string | undefined} packageDir the directory `npm run … --prefix <dir>` runs the script in; the root when absent
 * @property {string[]} flags arguments that start with a dash
 * @property {string[]} positionals every other argument
 */

const COMMAND = new RegExp(
  String.raw`(?:^|[\s;&|(])(${YARN}|npm run)[ \t]+([A-Za-z0-9][\w:.-]*)((?:[ \t]+[^\s#;&|]+)*)`,
  "g",
);

/**
 * `--prefix <dir>` is one of npm's own options wherever it stands on the line: it picks the package whose script
 * runs and never reaches the script, so it is neither a swallowed flag nor an argument.
 * @param {string[]} args the words after `npm run <script>`
 * @returns {{ packageDir: string | undefined, rest: string[] }}
 */
export function takeNpmPrefix(args) {
  const joined = args.findIndex(arg => arg.startsWith("--prefix="));
  if (joined >= 0) {
    return { packageDir: args[joined].slice("--prefix=".length), rest: args.filter((_, index) => index !== joined) };
  }
  const spaced = args.indexOf("--prefix");
  if (spaced < 0 || spaced + 1 >= args.length) return { packageDir: undefined, rest: args };
  return { packageDir: args[spaced + 1], rest: args.filter((_, index) => index !== spaced && index !== spaced + 1) };
}

/**
 * Finds the package-manager script invocations in one line of shell text.
 * @param {string} text
 * @returns {ScriptCommand[]}
 */
export function findScriptCommands(text) {
  return [...text.matchAll(COMMAND)].map(([, runner, script, tail]) => {
    const args = tail.split(/[ \t]+/).filter(Boolean);
    const { packageDir, rest } = runner === "npm run" ? takeNpmPrefix(args) : { packageDir: undefined, rest: args };
    return {
      script,
      packageDir,
      flags: rest.filter(arg => arg.startsWith("-")),
      positionals: rest.filter(arg => !arg.startsWith("-")),
    };
  });
}

/**
 * @param {ScriptCommand} command
 * @returns {boolean} true for `install`, alone or with the one flag the CLI strips by itself
 */
export function isSharedBuiltin(command) {
  if (!SHARED_BUILTINS.has(command.script) || command.positionals.length > 0) return false;
  return command.flags.every(flag => flag === "--immutable");
}

/**
 * A whole line or code span that is one flag-free script invocation, or the install command with the one flag the
 * CLI strips by itself, optionally followed by a shell comment.
 */
export const EXACT_COMMAND = new RegExp(
  String.raw`^\s*${YARN} (?:install --immutable|[A-Za-z0-9][\w:.-]*)\s*(?:#.*)?$`,
);
