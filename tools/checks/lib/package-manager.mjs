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
 * @property {string[]} flags arguments that start with a dash
 * @property {string[]} positionals every other argument
 */

const COMMAND = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:${YARN}|npm run)[ \t]+([A-Za-z0-9][\w:.-]*)((?:[ \t]+[^\s#;&|]+)*)`,
  "g",
);

/**
 * Finds the package-manager script invocations in one line of shell text.
 * @param {string} text
 * @returns {ScriptCommand[]}
 */
export function findScriptCommands(text) {
  return [...text.matchAll(COMMAND)].map(match => {
    const args = match[2].split(/[ \t]+/).filter(Boolean);
    return {
      script: match[1],
      flags: args.filter(arg => arg.startsWith("-")),
      positionals: args.filter(arg => !arg.startsWith("-")),
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
