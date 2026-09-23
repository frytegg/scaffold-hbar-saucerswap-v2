// @ts-check
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// The zero-setup command of this template: it prints three failures this project met on Hedera testnet, replayed
// from the answers captured at the time, and needs no key, no wallet, no account and no network.
//
// It is plain Node because a scaffold has nothing else to offer: the report itself is TypeScript, beside the library
// whose sentences it shows, so this file boots the Vite this package already depends on and loads that module
// through it. Vite is asked for no config file and no port: nothing is served, nothing is watched, and the only
// alias it needs is the one the app's own imports use.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const REPORT = "./lib/hedera/__live__/replayCaptured.ts";

const server = await createServer({
  configFile: false,
  envFile: false,
  root,
  logLevel: "error",
  appType: "custom",
  // No HTTP server, no file watcher and no hot-reload socket: this runs once and prints. Without `hmr: false` the
  // dev server still binds a WebSocket port, which a command that claims to touch no network has no business doing.
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  resolve: { alias: [{ find: /^~~\//, replacement: root }] },
});

try {
  const { renderReport, replayBehaviours } = await server.ssrLoadModule(REPORT);
  process.stdout.write(renderReport(await replayBehaviours()));
} finally {
  await server.close();
}
