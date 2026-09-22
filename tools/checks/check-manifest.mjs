// @ts-check
import { existsSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadPublishedCli, sliceCliBundle } from "./lib/cli-bundle.mjs";
import { isMainModule, resultFrom, runCli, skipped } from "./lib/report.mjs";
import { readText } from "./lib/repo.mjs";
import { loadCliZod } from "./lib/zod.mjs";

const MANIFEST = "template.json";
const OFFLINE = "NOT VERIFIED: the registry is unreachable and nothing usable is cached";

/** @typedef {{ safeParse: (input: unknown) => { success: true, data: unknown } | { success: false, error: { issues: { path: (string | number)[], message: string }[] } } }} ManifestSchema */

/**
 * @param {string} schemaSource zod declarations sliced from the published CLI
 * @param {unknown} z
 * @returns {ManifestSchema}
 */
export function buildSchema(schemaSource, z) {
  return new Function("z", `${schemaSource}\nreturn TemplateManifestSchema;`)(z);
}

/**
 * @param {unknown} input
 * @param {unknown} parsed
 * @param {string} at
 * @returns {string[]} keys of the input that parsing dropped: the schema ignores what it does not know
 */
export function droppedKeys(input, parsed, at = "") {
  if (input === null || typeof input !== "object") return [];
  return Object.entries(input).flatMap(([key, value]) => {
    const here = Array.isArray(input) ? `${at}[${key}]` : at ? `${at}.${key}` : key;
    const counterpart = parsed !== null && typeof parsed === "object" ? Reflect.get(parsed, key) : undefined;
    return counterpart === undefined && value !== undefined ? [here] : droppedKeys(value, counterpart, here);
  });
}

/**
 * @param {string} label which form of the manifest this is
 * @param {string} text
 * @param {ManifestSchema} schema
 * @returns {import("./lib/report.mjs").Finding[]}
 */
export function validateManifest(label, text, schema) {
  let input;
  try {
    input = JSON.parse(text);
  } catch (error) {
    return [
      { file: MANIFEST, message: `${label}: not valid JSON (${error instanceof Error ? error.message : error})` },
    ];
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    return result.error.issues.map(issue => ({
      file: MANIFEST,
      message: `${label}: ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    }));
  }
  if (isDeepStrictEqual(result.data, input)) return [];
  const dropped = droppedKeys(input, result.data).map(key => `the CLI ignores "${key}": not a key of its schema`);
  const differences = dropped.length > 0 ? dropped : ["what the CLI parses is not what the file says"];
  return differences.map(difference => ({ file: MANIFEST, message: `${label}: ${difference}` }));
}

/** @type {import("./lib/report.mjs").Check} */
export const check = {
  name: "check-manifest",
  async run({ repoRoot, allowOffline }) {
    if (!existsSync(path.join(repoRoot, MANIFEST))) return skipped(`no ${MANIFEST}: the CLI removes it from scaffolds`);
    const cli = await loadPublishedCli({ allowOffline });
    if (!cli) return skipped(OFFLINE);
    const slices = sliceCliBundle(cli.bundle);
    const zod = await loadCliZod(cli, { allowOffline });
    if (!zod) return skipped(OFFLINE);

    const schema = buildSchema(slices.schemaSource, zod.z);
    const committed = readText(repoRoot, MANIFEST);
    // The CLI rewrites the manifest before parsing it, so an npm-mode scaffold sees the second form.
    const findings = [
      ...validateManifest("as committed", committed, schema),
      ...validateManifest("after the npm-mode rewrite", slices.rewriteText(committed), schema),
    ];
    return resultFrom(
      findings,
      `schema of create-scaffold-hbar@${cli.version} under zod@${zod.version}, from the ${cli.origin}`,
    );
  },
};

if (isMainModule(import.meta.url)) await runCli(check);
