// @ts-check
import path from "node:path";
import { loadPublishedCli, sliceCliBundle } from "./lib/cli-bundle.mjs";
import { YARN, takeNpmPrefix } from "./lib/package-manager.mjs";
import { isMainModule, resultFrom, runCli, skipped } from "./lib/report.mjs";
import { isHostKit, listTrackedFiles, readJson, readRootScripts, readText } from "./lib/repo.mjs";

/** @typedef {import("./lib/report.mjs").Finding} Finding */
/** @typedef {Pick<import("./lib/cli-bundle.mjs").CliSlices, "rewriteText" | "transformScript">} Rewriter */

const CODE_FILE = /\.[cm]?[jt]s$/;
const SHOWN_LENGTH = 90;
const CONTEXT_LENGTH = 30;

/** The manifests whose scripts the CLI converts (filterRootPackageJson, normalizeWorkspacePackagesForNpm). */
const SCRIPT_CONVERTED_MANIFESTS = new Set([
  "package.json",
  "packages/hardhat/package.json",
  "packages/nextjs/package.json",
]);

/** What the rewrite is known to produce when the text was not written for it. Each one misleads or breaks a command. */
const DAMAGE = [
  { pattern: /\bnpm\s+run\s+run\b/, why: "a doubled `run`: the text already spelled the npm-mode command" },
  {
    pattern: /\bnpm\s+(?:run\s+)?(?:or|and|vs)\s+npm\b/,
    why: "a sentence that named both package managers now names one twice",
  },
  { pattern: /\bnpm\.lock\b/, why: "the lockfile got a name that no package manager writes" },
  { pattern: /\bnpm\s+run\s+create\b/, why: "the scaffold command became a call to a `create` script" },
  { pattern: /(?:^|\s)--\s+--(?:\s|$)/, why: "`-- --`: the script receives a literal `--`" },
];

/**
 * Changes that are not script conversions and still do no harm: nothing reads the line afterwards, or the new value
 * is the one an npm-mode scaffold needs. Anything else the rewrite touches has to be a clean script conversion.
 */
const TOLERATED = [
  // Ignore patterns are neither run nor shown.
  { file: /(^|\/)\.(?:git|prettier)ignore$/, line: /^/ },
  // An npm-mode scaffold loses the hook and the scripts that load this file.
  { file: /^\.lintstagedrc\.js$/, line: /^/ },
  // Capabilities and defaults are read before the rewrite, and the schema accepts the rewritten values.
  { file: /^template\.json$/, line: /^\s*"packageManager":/ },
  // setup-node caches by package-manager name, and the rewrite puts the npm-mode one there.
  { file: /^\.github\/workflows\/[^/]+\.ya?ml$/, line: new RegExp(String.raw`^\s*cache:\s*${YARN}\s*$`) },
];

const CONVERTIBLE = new RegExp(String.raw`\b${YARN}[ \t]+(install(?:[ \t]+--immutable)?|[A-Za-z0-9:_-]+)`, "g");
const FLAG_AFTER_SCRIPT = /\bnpm run [A-Za-z0-9:_.-]+[ \t]+-/;
const NPM_RUN = /\bnpm run ([A-Za-z0-9:_.-]+)((?:[ \t]+[^\s;&|]+)*)/g;

/**
 * @param {string} text
 * @param {number} [from] where the interesting part starts
 * @returns {string} an excerpt short enough for one report line
 */
function shown(text, from = 0) {
  const start = Math.max(0, Math.min(from - CONTEXT_LENGTH, text.length - SHOWN_LENGTH));
  const excerpt = text.slice(start, start + SHOWN_LENGTH).trim();
  return `${start > 0 ? "…" : ""}${excerpt}${start + SHOWN_LENGTH < text.length ? "…" : ""}`;
}

/**
 * @param {string} before
 * @param {string} after
 * @returns {string} both versions of a line, cut around the first character that differs
 */
function shownChange(before, after) {
  let first = 0;
  while (first < before.length && before[first] === after[first]) first += 1;
  return `"${shown(before, first)}" becomes "${shown(after, first)}"`;
}

/**
 * @param {string} line
 * @param {Set<string>} scripts
 * @returns {string} the line as a rewrite limited to clean conversions would leave it
 */
function convertKnownScripts(line, scripts) {
  return line.replace(CONVERTIBLE, (match, word) => {
    if (word.startsWith("install")) return "npm install";
    return scripts.has(word) ? `npm run ${word}` : match;
  });
}

/**
 * Judges what the CLI's text rewrite does to one file.
 * @param {object} input
 * @param {string} input.file
 * @param {string} input.before
 * @param {string} input.after
 * @param {Set<string>} input.scripts root scripts, the only commands a doc may show
 * @returns {Finding[]}
 */
export function inspectTextRewrite({ file, before, after, scripts }) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  /** @type {Finding[]} */
  const findings = [];

  afterLines.forEach((text, index) => {
    for (const { pattern, why } of DAMAGE) {
      if (pattern.test(text)) findings.push({ file, line: index + 1, message: `after the rewrite: ${why}` });
    }
  });
  if (beforeLines.length !== afterLines.length) {
    const first = beforeLines.findIndex((text, index) => convertKnownScripts(text, scripts) !== afterLines[index]);
    const message = `the rewrite joins lines (${beforeLines.length} become ${afterLines.length}): a line ends in "npm"`;
    return [...findings, { file, line: first + 1, message }];
  }

  beforeLines.forEach((text, index) => {
    const rewritten = afterLines[index];
    if (rewritten === text || TOLERATED.some(rule => rule.file.test(file) && rule.line.test(text))) return;
    const place = { file, line: index + 1 };
    if (CODE_FILE.test(file)) {
      findings.push({
        ...place,
        message: `the rewrite alters this source line; name the script only: "${shown(text)}"`,
      });
    } else if (convertKnownScripts(text, scripts) !== rewritten) {
      findings.push({ ...place, message: `not a clean script conversion: ${shownChange(text, rewritten)}` });
    } else if (FLAG_AFTER_SCRIPT.test(rewritten)) {
      findings.push({ ...place, message: `the flag in "${shown(rewritten)}" never reaches the script: use an alias` });
    }
  });
  return findings;
}

/**
 * Replays what the CLI does to a `package.json`: script conversion first where it converts scripts, then the text
 * rewrite.
 * @param {object} input
 * @param {string} input.file
 * @param {any} input.manifest
 * @param {boolean} input.convertsScripts false for the manifests whose scripts only get the text rewrite
 * @param {Map<string, Set<string>>} input.workspaceScripts scripts of each workspace, by package name
 * @param {Map<string, Set<string>>} [input.scriptsByDir] scripts of each package, by directory, for `--prefix <dir>`
 * @param {Rewriter} input.rewriter
 * @returns {Finding[]}
 */
export function inspectPackageManifest({
  file,
  manifest,
  convertsScripts,
  workspaceScripts,
  scriptsByDir = new Map(),
  rewriter,
}) {
  /** @type {Finding[]} */
  const findings = [];
  const { scripts = {}, ...rest } = manifest;
  // Where the CLI converts the scripts, it also sets `packageManager` itself.
  if (convertsScripts) delete rest.packageManager;
  const ownScripts = new Set(Object.keys(scripts));

  const restText = JSON.stringify(rest, null, 2);
  const restAfter = rewriter.rewriteText(restText).split("\n");
  restText.split("\n").forEach((text, index) => {
    if (restAfter[index] !== text) findings.push({ file, message: `the rewrite alters "${shown(text)}"` });
  });

  for (const [key, value] of Object.entries(scripts)) {
    const converted = convertsScripts ? rewriter.transformScript(String(value), "npm") : String(value);
    const final = rewriter.rewriteText(converted);
    if (convertsScripts && final !== converted) {
      findings.push({
        file,
        message: `script "${key}": the CLI converts it to "${converted}", then mangles it to "${final}"`,
      });
    }
    for (const [, name, tail] of final.matchAll(NPM_RUN)) {
      const { packageDir, rest: args } = takeNpmPrefix(tail.split(/[ \t]+/).filter(Boolean));
      const workspace = args[0] === "-w" ? args[1] : undefined;
      // A script runs where its package.json is, so a prefix is relative to that directory.
      const prefixed = packageDir && path.posix.normalize(path.posix.join(path.posix.dirname(file), packageDir));
      const known = prefixed
        ? scriptsByDir.get(prefixed)
        : workspace === undefined
          ? ownScripts
          : workspaceScripts.get(workspace);
      if (!known?.has(name)) {
        findings.push({ file, message: `script "${key}" becomes "${final}", and "${name}" is not a script there` });
      }
      const forwarded = args.slice(workspace === undefined ? 0 : 2);
      const separator = forwarded.indexOf("--");
      const swallowed = forwarded.slice(0, separator === -1 ? undefined : separator).filter(arg => arg.startsWith("-"));
      if (swallowed.length > 0) {
        const message = `script "${key}" becomes "${final}": ${swallowed.join(" ")} never reaches the script`;
        findings.push({ file, message });
      }
    }
  }
  return findings;
}

/** @type {import("./lib/report.mjs").Check} */
export const check = {
  name: "check-rewrite",
  async run({ repoRoot, allowOffline }) {
    const cli = await loadPublishedCli({ allowOffline });
    if (!cli) return skipped("NOT VERIFIED: the registry is unreachable and no published CLI is cached");
    const slices = sliceCliBundle(cli.bundle);

    const removed = slices.removedInNpmMode;
    const files = listTrackedFiles(repoRoot).filter(file => {
      if (isHostKit(file) || file.startsWith(`${slices.skippedDir}/`)) return false;
      if (removed.some(gone => file === gone || file.startsWith(`${gone}/`))) return false;
      return slices.textExtensions.has(path.extname(file)) || slices.extraFileNames.includes(path.basename(file));
    });
    const manifests = files.filter(file => path.posix.basename(file) === "package.json");
    const packages = manifests.map(file => {
      const manifest = readJson(repoRoot, file);
      return {
        dir: path.posix.dirname(file),
        name: String(manifest.name),
        scripts: new Set(Object.keys(manifest.scripts ?? {})),
      };
    });
    const workspaceScripts = new Map(packages.map(({ name, scripts }) => [name, scripts]));
    const scriptsByDir = new Map(packages.map(({ dir, scripts }) => [dir, scripts]));
    const scripts = readRootScripts(repoRoot);

    const findings = files.flatMap(file => {
      if (manifests.includes(file)) {
        return inspectPackageManifest({
          file,
          manifest: readJson(repoRoot, file),
          convertsScripts: SCRIPT_CONVERTED_MANIFESTS.has(file),
          workspaceScripts,
          scriptsByDir,
          rewriter: slices,
        });
      }
      const before = readText(repoRoot, file);
      return inspectTextRewrite({ file, before, after: slices.rewriteText(before), scripts });
    });
    return resultFrom(findings, `create-scaffold-hbar@${cli.version} from the ${cli.origin}, ${files.length} files`);
  },
};

if (isMainModule(import.meta.url)) await runCli(check);
