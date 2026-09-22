// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createThrottle } from "../src/modes.mjs";

describe("createThrottle", () => {
  it("answers 429 to the first request of a host and 400 to every later one", () => {
    const throttle = createThrottle();
    assert.deepEqual(
      [throttle("testnet.hashio.io"), throttle("testnet.hashio.io"), throttle("testnet.hashio.io")],
      [429, 400, 400],
    );
  });

  it("rate-limits each host on its own", () => {
    const throttle = createThrottle();
    throttle("testnet.hashio.io");
    assert.equal(throttle("testnet.mirrornode.hedera.com"), 429);
  });

  it("does not share state between page loads", () => {
    createThrottle()("testnet.hashio.io");
    assert.equal(createThrottle()("testnet.hashio.io"), 429);
  });
});
