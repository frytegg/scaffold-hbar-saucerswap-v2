// @ts-check
import { cachedVersions, fetchTarball, fetchVersion, highestVersion, readCachedTarball } from "./registry.mjs";
import { UnverifiableError } from "./report.mjs";
import { readTarball } from "./tarball.mjs";

const PACKAGE = "create-scaffold-hbar";
const BUNDLE_PATH = "package/dist/cli.js";
const MANIFEST_PATH = "package/package.json";

/**
 * @typedef {object} PublishedCli
 * @property {string} version
 * @property {string} bundle the source of `dist/cli.js`
 * @property {Record<string, string>} dependencies what the CLI declares, and so what `npx` installs next to it
 * @property {"registry" | "cache"} origin
 */
/**
 * @typedef {object} CliSlices
 * @property {(content: string) => string} rewriteText the npm-mode rewrite the CLI applies to text files
 * @property {(script: string, packageManager: string) => string} transformScript its rewrite of `package.json` scripts
 * @property {Set<string>} textExtensions extensions of the files it rewrites
 * @property {string[]} extraFileNames files it rewrites whatever their extension
 * @property {string} skippedDir the one tree it never rewrites
 * @property {string[]} removedInNpmMode paths it deletes before rewriting
 * @property {string} schemaSource the zod declarations of the template manifest, `z` being free
 */

/**
 * @param {string} version
 * @param {Buffer} tarball
 * @param {PublishedCli["origin"]} origin
 * @returns {PublishedCli}
 */
function unpack(version, tarball, origin) {
  const files = readTarball(tarball);
  const bundle = files.get(BUNDLE_PATH);
  const manifest = files.get(MANIFEST_PATH);
  if (!bundle || !manifest) {
    throw new UnverifiableError(`${PACKAGE}@${version} changed: its tarball lacks ${BUNDLE_PATH} or ${MANIFEST_PATH}`);
  }
  const { dependencies = {} } = JSON.parse(manifest.toString("utf8"));
  return { version, bundle: bundle.toString("utf8"), dependencies, origin };
}

/** @returns {Promise<PublishedCli>} */
async function fetchLatest() {
  const published = await fetchVersion(PACKAGE, "latest");
  return unpack(published.version, await fetchTarball(published), "registry");
}

/** @returns {PublishedCli | undefined} the highest version that an earlier online run left in the cache */
function newestCached() {
  const version = highestVersion(cachedVersions(PACKAGE));
  return version === undefined ? undefined : unpack(version, readCachedTarball(PACKAGE, version), "cache");
}

/** @type {Promise<PublishedCli> | undefined} one download per process, shared by the checks that need it */
let latest;

/**
 * @param {{ allowOffline: boolean }} options
 * @returns {Promise<PublishedCli | undefined>} undefined only when offline runs are allowed and nothing is cached
 */
export async function loadPublishedCli({ allowOffline }) {
  latest ??= fetchLatest();
  try {
    return await latest;
  } catch (error) {
    if (!(error instanceof UnverifiableError) || !allowOffline) throw error;
    console.error(
      `${PACKAGE}@latest is unreachable (${error.message}); --allow-offline is set, using the cache if any`,
    );
    return newestCached();
  }
}

/**
 * @param {string[]} lines
 * @param {string} first the exact first line of a top-level statement
 * @param {string} last the exact line that closes it
 * @returns {string}
 */
function sliceStatement(lines, first, last) {
  const start = lines.indexOf(first);
  const end = start === -1 ? -1 : lines.indexOf(last, start);
  if (end === -1) {
    throw new UnverifiableError(
      `${PACKAGE} changed: "${first}" … "${last}" is no longer in ${BUNDLE_PATH}. ` +
        "Read the new bundle, then update the anchors in tools/checks/lib/cli-bundle.mjs.",
    );
  }
  return lines.slice(start, end + 1).join("\n");
}

/**
 * Cuts the pieces of the published bundle that decide what an npm-mode scaffold looks like, and makes them callable.
 * @param {string} bundle
 * @returns {CliSlices}
 */
export function sliceCliBundle(bundle) {
  const lines = bundle.split(/\r?\n/);
  const rewrite = sliceStatement(lines, "function replaceYarnReference(content) {", "}");
  const transform = sliceStatement(lines, "function transformScriptForPackageManager(script, packageManager) {", "}");
  const extensions = sliceStatement(lines, "const TEXT_FILE_EXTENSIONS = new Set([", "]);");
  const removed = sliceStatement(lines, "const YARN_SPECIFIC_PATHS = [", "];");
  const skipped = sliceStatement(
    lines,
    'const HARNESS_RECIPE_DIR = ".harness";',
    'const HARNESS_RECIPE_DIR = ".harness";',
  );
  const walker = sliceStatement(lines, "function updateTextFilesForNpm(targetDir, packageManager) {", "}");
  const schemaSource = sliceStatement(lines, "const EnvVarSchema = z.object({", "}));");

  const extraFileNames = [...walker.matchAll(/entry\.name !== "([^"]+)"/g)].map(match => match[1]);
  if (extraFileNames.length === 0) {
    throw new UnverifiableError(
      `${PACKAGE} changed: updateTextFilesForNpm no longer names the extra files it rewrites`,
    );
  }
  const evaluated = new Function(
    `${rewrite}\n${transform}\n${extensions}\n${removed}\n${skipped}\n` +
      "return { replaceYarnReference, transformScriptForPackageManager, TEXT_FILE_EXTENSIONS, YARN_SPECIFIC_PATHS, HARNESS_RECIPE_DIR };",
  )();
  return {
    rewriteText: evaluated.replaceYarnReference,
    transformScript: evaluated.transformScriptForPackageManager,
    textExtensions: evaluated.TEXT_FILE_EXTENSIONS,
    extraFileNames,
    skippedDir: evaluated.HARNESS_RECIPE_DIR,
    removedInNpmMode: evaluated.YARN_SPECIFIC_PATHS,
    schemaSource,
  };
}
