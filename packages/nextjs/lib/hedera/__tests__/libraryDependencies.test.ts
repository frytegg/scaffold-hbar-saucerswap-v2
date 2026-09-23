import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What a caller copies: the modules at the top of `lib/hedera`, without `__tests__/` and `__live__/`, which are this
 * repository's own test and script tiers. `docs/use-the-checks-in-your-app.md` tells a developer with their own app
 * to copy that directory and says it needs viem and nothing else; this is what makes that sentence checkable. An
 * import of Next.js, of React, of wagmi, or of anything reached through the `~~` alias would arrive in their project
 * as a module they do not have, and the page would be wrong rather than merely optimistic.
 */
const LIBRARY = fileURLToPath(new URL("../", import.meta.url));

/** The one package the page names as a dependency of what it asks the reader to copy. */
const DEPENDENCIES = new Set(["viem"]);

/**
 * The three shapes a module specifier arrives in. The word before the quotation mark has to be a word of its own:
 * `addressAt(result, "from", path)` in `mirror.ts` is a field name inside a string, not an import of `, path)`.
 */
const SPECIFIER = [
  /(?:^|[\s}])from\s*["']([^"']+)["']/gm,
  /^import\s*["']([^"']+)["']/gm,
  /(?:^|[\s(=,])(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gm,
];

const modules = readdirSync(LIBRARY, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
  .map(entry => entry.name);

const moduleNames = new Set(modules.map(name => name.replace(/\.ts$/, "")));

function specifiersOf(file: string): string[] {
  const source = readFileSync(path.join(LIBRARY, file), "utf8");
  return SPECIFIER.flatMap(pattern => [...source.matchAll(pattern)].map(match => match[1]));
}

/** A specifier that names another module of the same directory, which travels with it when the directory is copied. */
function isSibling(specifier: string): boolean {
  return specifier.startsWith("./") && moduleNames.has(specifier.slice("./".length));
}

describe("what the library needs to be copied into another project", () => {
  it("imports its own modules and viem, and nothing else", () => {
    const foreign = modules.flatMap(file =>
      specifiersOf(file)
        .filter(specifier => !DEPENDENCIES.has(specifier) && !isSibling(specifier))
        .map(specifier => `${file} imports ${specifier}`),
    );
    expect(foreign).toEqual([]);
  });

  it("reads the whole library, so an empty read cannot pass the check above", () => {
    expect(moduleNames.has("index")).toBe(true);
    expect(modules.length).toBeGreaterThan(20);
    expect(specifiersOf("index.ts").length).toBeGreaterThan(20);
  });

  it("would report an import of something the reader does not get", () => {
    expect(isSibling("./preflight")).toBe(true);
    expect(isSibling("~~/services/hedera/upstreams")).toBe(false);
    expect(isSibling("./__live__/testnet")).toBe(false);
    expect(DEPENDENCIES.has("wagmi")).toBe(false);
  });
});
