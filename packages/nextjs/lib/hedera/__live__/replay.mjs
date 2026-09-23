// @ts-check
import { withTsLoader } from "./loadTs.mjs";

// The zero-setup command of this template: it prints three failures this project met on Hedera testnet, replayed
// from the answers captured at the time, and needs no key, no wallet, no account and no network.
//
// It is plain Node because a scaffold has nothing else to offer: the report itself is TypeScript, beside the library
// whose sentences it shows, so loadTs.mjs loads that module through the Vite this package already depends on.

const REPORT = "./lib/hedera/__live__/replayCaptured.ts";

const report = await withTsLoader(async load => {
  const { renderReport, replayBehaviours } = await load(REPORT);
  return renderReport(await replayBehaviours());
});

process.stdout.write(report);
