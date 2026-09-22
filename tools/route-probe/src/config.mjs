// @ts-check
import { readFile } from "node:fs/promises";

export class ProbeConfigError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = "ProbeConfigError";
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, string[]>}
 */
function isSampleMap(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(paths => Array.isArray(paths) && paths.every(path => typeof path === "string"))
  );
}

/**
 * @param {string} configFile
 * @returns {Promise<{ dynamicRouteSamples: Record<string, string[]> }>}
 */
export async function loadConfig(configFile) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configFile, "utf8"));
  } catch (error) {
    throw new ProbeConfigError(`Cannot read the probe configuration at ${configFile}.`, { cause: error });
  }

  const samples =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "dynamicRouteSamples") : undefined;
  if (!isSampleMap(samples)) {
    throw new ProbeConfigError(
      `${configFile}: "dynamicRouteSamples" must map each dynamic route to a list of concrete paths.`,
    );
  }

  return { dynamicRouteSamples: samples };
}
