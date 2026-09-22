import unit from "./vitest.config";
import { defineConfig } from "vitest/config";

// Tier 3: keyless reads of Hedera testnet through hashio and the mirror node. A failure can be a third party's.
export default defineConfig({
  resolve: unit.resolve,
  test: {
    include: ["lib/hedera/__live__/*.live.ts"],
    environment: "node",
    reporters: ["verbose"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
