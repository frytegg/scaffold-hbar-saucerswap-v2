// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SHOTS, missingExpectations, oversizeFailure, panelCountFailure } from "../src/shots.mjs";

const REFUSAL_PANEL = `The same checks, with no wallet
These checks take an address, not a key. This runs the quote and the whole pre-flight for 1 SAUCE against
0.0.10645914, the account the transactions in docs/hedera-behaviour.md were sent from, and shows what Hedera
testnet answers for it right now. Nothing is signed, nothing is sent, and every read leaves from this app's
own origin.
Run the pre-flight
blocked The router may spend your token
The SaucerSwap router has no allowance to spend your SAUCE. Approve 1 SAUCE first: without it the network
rejects the swap and still charges the gas.
What to do: Approve 1 SAUCE for the router`;

describe("missingExpectations", () => {
  it("reports nothing when the panel says everything the caption claims", () => {
    const shot = SHOTS[0];
    assert.ok(shot, "the refusal shot is declared");
    assert.deepEqual(missingExpectations(REFUSAL_PANEL, shot.expect), []);
  });

  it("names the sentence a wrapped paragraph still holds, because a line break is not a difference", () => {
    assert.deepEqual(missingExpectations(REFUSAL_PANEL, ["rejects the swap and still charges the gas"]), []);
  });

  it("names the verdict that changed, which is how a stale picture is refused", () => {
    assert.deepEqual(missingExpectations(REFUSAL_PANEL.replace("blocked", "passed"), ["blocked"]), ["blocked"]);
  });

  it("names the action that disappeared, and leaves the reason that did not", () => {
    const withoutAction = REFUSAL_PANEL.replace("What to do: Approve 1 SAUCE for the router", "");
    assert.deepEqual(missingExpectations(withoutAction, ["blocked", "What to do: Approve 1 SAUCE for the router"]), [
      "What to do: Approve 1 SAUCE for the router",
    ]);
  });
});

describe("oversizeFailure", () => {
  it("passes a file at the limit and refuses the first byte above it", () => {
    assert.equal(oversizeFailure(150 * 1024), null);
    assert.equal(oversizeFailure(150 * 1024 + 1), "150 KB: over the 150 KB limit for a shipped image");
  });

  it("says how big the file that was written actually is", () => {
    assert.equal(oversizeFailure(320 * 1024), "320 KB: over the 150 KB limit for a shipped image");
  });
});

describe("panelCountFailure", () => {
  const shot = { file: "x.png", route: "/swap", panel: "The same checks, with no wallet", shows: "", expect: [] };

  it("accepts the one section the shot names", () => {
    assert.equal(panelCountFailure(1, shot), null);
  });

  it("refuses a panel that is gone, and one that is now ambiguous", () => {
    assert.match(String(panelCountFailure(0, shot)), /^\/swap has 0 sections holding "The same checks/);
    assert.match(String(panelCountFailure(2, shot)), /^\/swap has 2 sections holding "The same checks/);
  });
});

describe("the declared shots", () => {
  it("write distinct PNG files, each with something it must be showing", () => {
    const files = SHOTS.map(shot => shot.file);
    assert.equal(new Set(files).size, files.length);
    for (const shot of SHOTS) {
      assert.match(shot.file, /^[a-z0-9-]+\.png$/);
      assert.ok(shot.expect.length > 0, `${shot.file} states what it shows`);
      assert.ok(shot.route.startsWith("/"), `${shot.file} names a route`);
    }
  });
});
