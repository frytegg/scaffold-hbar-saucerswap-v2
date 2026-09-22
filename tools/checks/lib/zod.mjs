// @ts-check
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  CACHE_DIR,
  cachedVersions,
  fetchTarball,
  fetchVersions,
  maxSatisfying,
  readCachedTarball,
} from "./registry.mjs";
import { UnverifiableError } from "./report.mjs";
import { readTarball } from "./tarball.mjs";

const ZOD = "zod";
const PACKAGE_ROOT = "package/";

/**
 * @param {string} home
 * @returns {boolean}
 */
function isUnpacked(home) {
  return existsSync(path.join(home, "node_modules", ZOD, "package.json"));
}

/** @typedef {{ z: unknown, version: string }} LoadedZod */

/**
 * Lays a zod tarball out as `<cache>/zod-<version>/node_modules/zod`, where Node's own resolution finds it.
 * @param {string} version
 * @param {Buffer} tarball
 * @returns {LoadedZod}
 */
function requireUnpacked(version, tarball) {
  const home = path.join(CACHE_DIR, `${ZOD}-${version}`);
  if (!isUnpacked(home)) {
    const partial = `${home}.${process.pid}.partial`;
    const packageDir = path.join(partial, "node_modules", ZOD);
    for (const [name, content] of readTarball(tarball)) {
      if (!name.startsWith(PACKAGE_ROOT)) continue;
      const target = path.resolve(packageDir, name.slice(PACKAGE_ROOT.length));
      if (!target.startsWith(packageDir + path.sep)) {
        throw new UnverifiableError(`zod@${version}: the tarball entry "${name}" points outside the package`);
      }
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    try {
      renameSync(partial, home);
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      // Another run unpacked the same version first: its copy is complete, since only finished copies are renamed.
      if (!isUnpacked(home)) throw error;
    }
  }
  const { z } = createRequire(path.join(home, "index.js"))(ZOD);
  if (typeof z?.object !== "function") throw new UnverifiableError(`zod@${version} exports no usable "z" namespace`);
  return { z, version };
}

/**
 * The zod that `npx create-scaffold-hbar` installs next to the CLI: the highest version of the range the CLI declares.
 * The CLI keeps zod outside its bundle, so the sliced schema needs this one to behave as it does for the judges.
 * @param {import("./cli-bundle.mjs").PublishedCli} cli
 * @param {{ allowOffline: boolean }} options
 * @returns {Promise<LoadedZod | undefined>} undefined only when offline runs are allowed and nothing is cached
 */
export async function loadCliZod(cli, { allowOffline }) {
  const range = cli.dependencies[ZOD];
  if (range === undefined) {
    throw new UnverifiableError(
      `create-scaffold-hbar@${cli.version} no longer depends on zod: read its bundle, then update tools/checks/lib/zod.mjs`,
    );
  }
  try {
    const versions = await fetchVersions(ZOD);
    const version = maxSatisfying([...versions.keys()], range);
    const published = version === undefined ? undefined : versions.get(version);
    if (version === undefined || published === undefined) {
      throw new UnverifiableError(`no published zod version satisfies ${range}`);
    }
    return requireUnpacked(version, await fetchTarball(published));
  } catch (error) {
    if (!(error instanceof UnverifiableError) || !allowOffline) throw error;
    const version = maxSatisfying(cachedVersions(ZOD), range);
    console.error(
      `zod ${range} could not be resolved online (${error.message}); --allow-offline is set, using the cache`,
    );
    return version === undefined ? undefined : requireUnpacked(version, readCachedTarball(ZOD, version));
  }
}
