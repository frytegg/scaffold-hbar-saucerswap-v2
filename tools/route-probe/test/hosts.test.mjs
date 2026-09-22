// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createThirdPartyTest } from "../src/hosts.mjs";

describe("createThirdPartyTest", () => {
  const isThirdParty = createThirdPartyTest("http://localhost:3201");

  it("keeps the app's own origin and every loopback spelling local, whatever the port", () => {
    for (const url of [
      "http://localhost:3201/debug",
      "http://localhost:8545/",
      "http://127.0.0.1:8545/",
      "http://[::1]:3201/api/hedera/account",
      "ws://127.0.0.1:8545/",
    ]) {
      assert.equal(isThirdParty(url), false, url);
    }
  });

  it("flags every other host, over HTTP and over WebSocket", () => {
    for (const url of [
      "https://testnet.hashio.io/api",
      "https://fonts.googleapis.com/css2?family=Montserrat",
      "wss://relay.walletconnect.org/?auth=abc",
      "http://localhost.example.com/",
    ]) {
      assert.equal(isThirdParty(url), true, url);
    }
  });

  it("ignores URLs that never reach the network", () => {
    for (const url of ["data:image/svg+xml;base64,AAAA", "blob:http://localhost:3201/1b2c", "about:blank", ""]) {
      assert.equal(isThirdParty(url), false, url);
    }
  });

  it("treats the served host as local when the app is not on loopback", () => {
    const isThirdPartyOnLan = createThirdPartyTest("http://192.168.1.20:3000");
    assert.equal(isThirdPartyOnLan("http://192.168.1.20:3000/debug"), false);
    assert.equal(isThirdPartyOnLan("https://testnet.hashio.io/api"), true);
  });
});
