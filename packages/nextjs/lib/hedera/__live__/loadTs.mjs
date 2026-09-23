// @ts-check
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// How the plain Node commands of this template load the TypeScript beside them. What they print is the return value
// of a module of this package, so each one boots the Vite this package already depends on and loads that module
// through it: no new dependency, no HTTP server and no socket. Vite is asked for no config file and no port, so
// nothing is served and nothing is watched, and the only alias it needs is the one the app's own imports use.

const root = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Boots the loader, hands `run` a function that loads one module of this package by its path relative to the package
 * root, and closes the loader afterwards whatever happens.
 * @template T
 * @param {(load: (specifier: string) => Promise<any>) => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withTsLoader(run) {
  const server = await createServer({
    configFile: false,
    envFile: false,
    root,
    logLevel: "error",
    appType: "custom",
    // No HTTP server, no file watcher and no hot-reload socket: these commands run once and print. Without
    // `hmr: false` the dev server still binds a WebSocket port, which a command that reads nothing but Hedera's own
    // endpoints has no business doing. `host` is set for the same reason and not to listen anywhere: Vite resolves
    // the default host "localhost" through dns.promises.lookup while it starts, and a literal address is the one
    // branch of that code which asks no resolver.
    server: { middlewareMode: true, watch: null, hmr: false, ws: false, host: "127.0.0.1" },
    resolve: { alias: [{ find: /^~~\//, replacement: root }] },
  });

  try {
    return await run(specifier => server.ssrLoadModule(specifier));
  } finally {
    await server.close();
  }
}
