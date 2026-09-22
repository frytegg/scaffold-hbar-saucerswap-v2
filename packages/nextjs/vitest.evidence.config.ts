import unit from "./vitest.config";
import { defineConfig } from "vitest/config";

// Tier 4: signs and sends on Hedera testnet, then writes docs/evidence/. Skipped without __RUNTIME_DEPLOYER_PRIVATE_KEY.
export default defineConfig({
  resolve: unit.resolve,
  test: {
    include: ["lib/hedera/__live__/*.signed.ts"],
    environment: "node",
    reporters: ["verbose"],
    fileParallelism: false,
    bail: 1,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
