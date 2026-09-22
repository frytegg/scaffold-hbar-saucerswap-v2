// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withoutConfiguration } from "../src/server.mjs";

describe("withoutConfiguration", () => {
  it("gives the server none of the app's configuration variables, whatever the shell exports", () => {
    const { env, removed } = withoutConfiguration({
      PATH: "/usr/bin",
      NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID: "id",
      HEDERA_RPC_TESTNET_URL: "http://127.0.0.1:9",
      HEDERA_MIRROR_TESTNET_URL: "http://127.0.0.1:9",
    });
    assert.deepEqual(removed, [
      "HEDERA_MIRROR_TESTNET_URL",
      "HEDERA_RPC_TESTNET_URL",
      "NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID",
    ]);
    assert.deepEqual(env, { PATH: "/usr/bin", NEXT_TELEMETRY_DISABLED: "1" });
  });

  it("keeps variables that only contain a configuration prefix further in", () => {
    const { env } = withoutConfiguration({ MY_HEDERA_RPC_URL: "kept" });
    assert.equal(env.MY_HEDERA_RPC_URL, "kept");
  });
});
