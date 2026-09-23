// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { abbreviate, classifyTarget, findLinkFindings, headingSlug, linksIn } from "../check-links.mjs";
import { parseMarkdown } from "../lib/markdown.mjs";
import { fixtureDoc } from "./support.mjs";

const DOC = "docs/hedera-behaviour.md";
const FAILED_SWAP = "0xdf368443228e69c4ed1a2a7192d0978b15a51f219981cdd2d5f63250d1582352";
const PRESENT = new Set(["AGENTS.md", "docs/images/wallet-doomed-swap-confirmation.png"]);

/**
 * @param {import("../lib/markdown.mjs").MarkdownDoc} doc
 * @param {string[]} [recorded]
 */
function check(doc, recorded = [FAILED_SWAP]) {
  return findLinkFindings({
    doc,
    exists: file => PRESENT.has(file),
    slugsOf: file => (file === doc.file ? new Set(doc.headings.map(heading => headingSlug(heading.title))) : undefined),
    isRecorded: hash => recorded.includes(hash),
  });
}

test("a doc whose every target resolves has no finding", () => {
  assert.deepEqual(check(fixtureDoc("links-clean.markdown", DOC)), []);
});

test("the negative fixture fails, one finding per defect", () => {
  const findings = check(fixtureDoc("links-broken.markdown", DOC));
  assert.deepEqual(
    findings.map(finding => finding.message),
    [
      "`images/wallet-failed-interaction-detail.png` resolves to docs/images/wallet-failed-interaction-detail.png, " +
        "which no tracked path holds",
      "0xdeadbeef…beef is in no evidence record and no test fixture, so nothing here can tell it from an invented " +
        "hash: capture it, or declare it in a `checks:allow` links: entry",
      "the link shows 0xc0fb56df…976b and points at 0xdf368443…2352",
      'no heading of docs/hedera-behaviour.md has the anchor "#the-simulators-say-yes"',
      'this Hashscan link names "0.0.10645914-1758000000-000000000", which is no 32-byte hash',
      'allowlist entry "links: 0x1111111111111111111111111111111111111111111111111111111111111111" excuses ' +
        "nothing in this file: remove it",
    ],
  );
});

test("a renamed picture is caught although the old name is still spelled correctly", () => {
  const renamed = parseMarkdown(DOC, "![a wallet](images/wallet-doomed-swap-confirmations.png)");
  assert.equal(check(renamed).length, 1);
  assert.match(check(renamed)[0].message, /which no tracked path holds$/);
});

test("a proof link the repository cannot corroborate passes only when the doc declares it", () => {
  const link = `[\`0xdeadbeef…beef\`](https://hashscan.io/testnet/tx/0xdeadbeef${"0".repeat(52)}beef)`;
  assert.equal(check(parseMarkdown(DOC, link)).length, 1);
  const declared = `${link}\n\n<!-- checks:allow\nlinks: 0xdeadbeef${"0".repeat(52)}beef\n-->`;
  assert.deepEqual(check(parseMarkdown(DOC, declared)), []);
});

test("the mirror link and the Hashscan link of one row report their hash once", () => {
  const hash = `0xdeadbeef${"0".repeat(52)}beef`;
  const row = `| [a](https://hashscan.io/testnet/tx/${hash}) ([mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${hash})) |`;
  assert.equal(check(parseMarkdown(DOC, row)).length, 1);
});

test("a local target is resolved against the doc that names it, not against the repository root", () => {
  assert.deepEqual(check(parseMarkdown(DOC, "[the guide](../AGENTS.md)")), []);
  assert.equal(check(parseMarkdown(DOC, "[the guide](AGENTS.md)")).length, 1);
});

test("an anchor names a heading of the file it points at", () => {
  const doc = parseMarkdown(DOC, "[here](#a-burn-the-network-refuses)\n\n## A burn the network refuses");
  assert.deepEqual(check(doc), []);
  assert.equal(check(parseMarkdown(DOC, "[here](#a-burn)\n\n## A burn the network refuses")).length, 1);
});

test("links inside a fenced block are examples, not targets", () => {
  const fenced = "```text\n[a link](images/a-picture-nobody-took.png)\n```";
  assert.deepEqual(check(parseMarkdown(DOC, fenced)), []);
});

test("a destination is classified by its shape alone", () => {
  assert.deepEqual(classifyTarget("#top"), { kind: "anchor", anchor: "top" });
  assert.equal(classifyTarget("https://portal.hedera.com/faucet").kind, "external");
  assert.equal(classifyTarget(`https://hashscan.io/testnet/tx/${FAILED_SWAP}`).explorer, "Hashscan");
  const mirror = classifyTarget(`https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${FAILED_SWAP}`);
  assert.equal(mirror.mirrorUrl !== undefined, true, "only the mirror link is one --resolve can read");
});

test("a heading becomes the anchor GitHub gives it", () => {
  assert.equal(
    headingSlug("HBAR has two units, and the wrong one fails"),
    "hbar-has-two-units-and-the-wrong-one-fails",
  );
  assert.equal(
    headingSlug("The wallet prices the gas limit; the network charges"),
    "the-wallet-prices-the-gas-limit-the-network-charges",
  );
  assert.equal(headingSlug("`payable` and the **units**"), "payable-and-the-units");
});

test("a hash is abbreviated the way the docs write it", () => {
  assert.equal(abbreviate(FAILED_SWAP), "0xdf368443…2352");
});

test("an image and a link are told apart, so alt text is never read as a hash", () => {
  const [image, link] = linksIn(parseMarkdown(DOC, "![alt](a.png) and [text](b.md)"));
  assert.equal(image.image, true);
  assert.equal(link.image, false);
});
