// @ts-check
import path from "node:path";
import { createAllowlist, parseMarkdown } from "./lib/markdown.mjs";
import { isMainModule, resultFrom, runCli, UnverifiableError } from "./lib/report.mjs";
import { listDocs, listIgnored, listTrackedFiles, readText } from "./lib/repo.mjs";

/** @typedef {import("./lib/report.mjs").Finding} Finding */
/** @typedef {import("./lib/markdown.mjs").MarkdownDoc} MarkdownDoc */
/** @typedef {{ line: number, image: boolean, text: string, target: string }} Link */
/**
 * @typedef {object} Target what a link points at, read from its destination alone
 * @property {"anchor" | "local" | "transaction" | "external"} kind
 * @property {string} [file] repository path, as the link spells it, relative to the doc
 * @property {string} [anchor] heading slug, without its "#"
 * @property {string} [hash] the transaction a proof link names, exactly as written
 * @property {string} [explorer] how a finding names the site
 * @property {string} [mirrorUrl] set for the targets `--resolve` can read as JSON
 */

/** A Markdown link or image on one line. Reference-style links, and a destination split over two lines, are not seen. */
const LINK = /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+?)(?:\s+"[^"]*")?\s*\)/g;
const ABSOLUTE = /^[a-z][\w+.-]*:/i;

const MIRROR_RESULT = /^https:\/\/[a-z0-9-]+\.mirrornode\.hedera\.com\/api\/v1\/contracts\/results\/(.+)$/;
const HASHSCAN_TRANSACTION = /^https:\/\/hashscan\.io\/[a-z0-9-]+\/tx\/(.+)$/;
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const ANY_HASH = /0x[0-9a-fA-F]{64}/g;
/** How the docs write a hash in a link's own text: whole, or head…tail. */
const SHOWN_WHOLE = /^`?(0x[0-9a-fA-F]{64})`?$/;
const SHOWN_ABBREVIATED = /^`?(0x[0-9a-fA-F]{2,})(?:…|\.\.\.)([0-9a-fA-F]{2,})`?$/;

/** Where a transaction may be recorded: the signed evidence records, and the answers the offline tests replay. */
const EVIDENCE_RECORD = /^docs\/evidence\/.+\.json$/;
const TEST_FIXTURE = /(^|\/)__tests__\/fixtures\//;

const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_DELAYS_MS = [0, 1_000, 2_000];

/**
 * @param {string} hash
 * @returns {string} the head…tail form the docs use, so a finding reads like the line it is about
 */
export function abbreviate(hash) {
  return `${hash.slice(0, 10)}…${hash.slice(-4)}`;
}

/**
 * @param {MarkdownDoc} doc
 * @returns {Link[]} every link and image outside a fenced block, in document order
 */
export function linksIn(doc) {
  const outsideFences = new Set(doc.prose.map(({ line }) => line));
  return doc.lines.flatMap((text, index) =>
    outsideFences.has(index + 1)
      ? [...text.matchAll(LINK)].map(match => ({
          line: index + 1,
          image: match[1] === "!",
          text: match[2].trim(),
          target: match[3],
        }))
      : [],
  );
}

/**
 * @param {string} destination
 * @returns {Target}
 */
export function classifyTarget(destination) {
  const target = destination.replace(/^<|>$/g, "").trim();
  if (target.startsWith("#")) return { kind: "anchor", anchor: decodeURIComponent(target.slice(1)) };
  if (ABSOLUTE.test(target)) {
    const mirror = MIRROR_RESULT.exec(target);
    if (mirror) return { kind: "transaction", explorer: "the mirror node", hash: mirror[1], mirrorUrl: target };
    const hashscan = HASHSCAN_TRANSACTION.exec(target);
    if (hashscan) return { kind: "transaction", explorer: "Hashscan", hash: hashscan[1] };
    return { kind: "external" };
  }
  const [file, ...rest] = target.split("#");
  return {
    kind: "local",
    file: decodeURIComponent(file),
    anchor: rest.length > 0 ? decodeURIComponent(rest.join("#")) : undefined,
  };
}

/**
 * The anchor GitHub gives a heading: its text without inline markup, lowercased, punctuation dropped, spaces joined.
 * @param {string} title
 * @returns {string}
 */
export function headingSlug(title) {
  return title
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]{1,3}/g, "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * @param {MarkdownDoc} doc
 * @returns {Set<string>}
 */
export function headingSlugs(doc) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {Set<string>} */
  const slugs = new Set();
  for (const heading of doc.headings) {
    const slug = headingSlug(heading.title);
    const repeat = seen.get(slug) ?? 0;
    seen.set(slug, repeat + 1);
    // GitHub numbers a repeated heading: the second "Run" is "#run-1".
    slugs.add(repeat === 0 ? slug : `${slug}-${repeat}`);
  }
  return slugs;
}

/**
 * @param {Link} link
 * @param {string} hash the whole hash the destination carries, lowercased
 * @returns {string | undefined} why the text and the destination disagree, if they do
 */
function textDisagreement(link, hash) {
  const whole = SHOWN_WHOLE.exec(link.text);
  if (whole) return whole[1].toLowerCase() === hash ? undefined : `shows ${whole[1]}`;
  const abbreviated = SHOWN_ABBREVIATED.exec(link.text);
  if (!abbreviated) return undefined;
  const [, head, tail] = abbreviated;
  const shown = `${head}…${tail}`;
  return hash.startsWith(head.toLowerCase()) && hash.endsWith(tail.toLowerCase()) ? undefined : `shows ${shown}`;
}

/**
 * Every link resolves, and a proof link is one nothing in the repository can contradict.
 * @param {object} input
 * @param {MarkdownDoc} input.doc
 * @param {(file: string) => boolean} input.exists a tracked file, or one the ignore rules explain
 * @param {(file: string) => Set<string> | undefined} input.slugsOf undefined for a file that has no headings to name
 * @param {(hash: string) => boolean} input.isRecorded the hash is in an evidence record or a test fixture
 * @returns {Finding[]}
 */
export function findLinkFindings({ doc, exists, slugsOf, isRecorded }) {
  const allowlist = createAllowlist(doc, "links");
  const docDir = path.posix.dirname(doc.file);
  /** @type {Finding[]} */
  const findings = [];
  // The mirror link and the Hashscan link of one proof carry the same hash: report the hash once per doc.
  /** @type {Set<string>} */
  const reported = new Set();

  for (const link of linksIn(doc)) {
    const target = classifyTarget(link.target);
    const at = { file: doc.file, line: link.line };

    if (target.kind === "external") continue;

    if (target.kind === "transaction") {
      const hash = /** @type {string} */ (target.hash);
      if (!TRANSACTION_HASH.test(hash)) {
        findings.push({ ...at, message: `this ${target.explorer} link names "${hash}", which is no 32-byte hash` });
        continue;
      }
      const whole = hash.toLowerCase();
      if (!isRecorded(whole) && !allowlist.permits(whole) && !reported.has(whole)) {
        reported.add(whole);
        findings.push({
          ...at,
          message:
            `${abbreviate(whole)} is in no evidence record and no test fixture, so nothing here can tell it from ` +
            "an invented hash: capture it, or declare it in a `checks:allow` links: entry",
        });
      }
      const disagreement = link.image ? undefined : textDisagreement(link, whole);
      if (disagreement) {
        findings.push({ ...at, message: `the link ${disagreement} and points at ${abbreviate(whole)}` });
      }
      continue;
    }

    const file = target.kind === "anchor" ? doc.file : path.posix.normalize(path.posix.join(docDir, target.file ?? ""));
    if (file.startsWith("../")) {
      findings.push({ ...at, message: `\`${target.file}\` leaves the repository` });
      continue;
    }
    if (target.kind === "local" && !exists(file)) {
      findings.push({ ...at, message: `\`${target.file}\` resolves to ${file}, which no tracked path holds` });
      continue;
    }
    if (target.anchor === undefined) continue;
    const slugs = slugsOf(file);
    if (slugs === undefined) {
      findings.push({ ...at, message: `${file} has no headings, so "#${target.anchor}" names nothing in it` });
    } else if (!slugs.has(target.anchor)) {
      findings.push({ ...at, message: `no heading of ${file} has the anchor "#${target.anchor}"` });
    }
  }
  return [...findings, ...allowlist.staleEntries()];
}

/**
 * @param {string} repoRoot
 * @param {string[]} tracked
 * @returns {Set<string>} every transaction hash the repository records, lowercased
 */
export function recordedHashes(repoRoot, tracked) {
  /** @type {Set<string>} */
  const hashes = new Set();
  for (const file of tracked) {
    // A fixture README is prose about the captures, not a capture: a hash may not vouch for itself from there.
    const records = EVIDENCE_RECORD.test(file) || (TEST_FIXTURE.test(file) && !file.endsWith(".md"));
    if (!records) continue;
    for (const [hash] of readText(repoRoot, file).matchAll(ANY_HASH)) hashes.add(hash.toLowerCase());
  }
  return hashes;
}

/**
 * @param {string} url
 * @returns {Promise<Response>} a 404 is an answer about the transaction, so it comes back instead of throwing
 */
async function fetchWithRetry(url) {
  let lastFailure = "no attempt made";
  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok || response.status === 404) return response;
      lastFailure = `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastFailure = error instanceof Error ? `${error.message} (${String(error.cause ?? "no cause")})` : String(error);
    }
  }
  throw new UnverifiableError(`${url} could not be fetched: ${lastFailure}`);
}

/**
 * Reads each proof transaction off the mirror node and reports the status it recorded. A link the docs make is not
 * required to have succeeded — half of them prove a failure — so the answer is reported, and only a transaction the
 * mirror node does not know is a finding.
 * @param {{ hash: string, url: string, file: string, line: number }[]} proofs one per distinct hash
 * @returns {Promise<{ findings: Finding[], lines: string[] }>}
 */
async function resolveProofs(proofs) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const lines = [];
  for (const proof of proofs) {
    const response = await fetchWithRetry(proof.url);
    if (response.status === 404) {
      findings.push({ file: proof.file, line: proof.line, message: `the mirror node does not know ${proof.hash}` });
      lines.push(`  ${abbreviate(proof.hash)}  NOT FOUND`);
      continue;
    }
    const body = /** @type {{ result?: unknown }} */ (await response.json());
    if (typeof body.result !== "string") {
      findings.push({ file: proof.file, line: proof.line, message: `${proof.hash} came back with no result field` });
      lines.push(`  ${abbreviate(proof.hash)}  NO RESULT`);
      continue;
    }
    lines.push(`  ${abbreviate(proof.hash)}  ${body.result}`);
  }
  return { findings, lines };
}

/** @type {import("./lib/report.mjs").Check} */
export const check = {
  name: "check-links",
  async run({ repoRoot, resolve }) {
    const tracked = listTrackedFiles(repoRoot);
    const trackedSet = new Set(tracked);
    const docs = listDocs(tracked).map(file => parseMarkdown(file, readText(repoRoot, file)));
    const recorded = recordedHashes(repoRoot, tracked);

    /** @type {Map<string, boolean>} */
    const presence = new Map();
    /** @param {string} file */
    const exists = file => {
      // Generated and local files are legitimate link targets although git does not track them.
      if (!presence.has(file)) presence.set(file, trackedSet.has(file) || listIgnored(repoRoot, [file]).size > 0);
      return /** @type {boolean} */ (presence.get(file));
    };
    /** @type {Map<string, Set<string> | undefined>} */
    const slugCache = new Map();
    /** @param {string} file */
    const slugsOf = file => {
      if (!slugCache.has(file)) {
        const markdown = file.endsWith(".md") && trackedSet.has(file);
        slugCache.set(file, markdown ? headingSlugs(parseMarkdown(file, readText(repoRoot, file))) : undefined);
      }
      return slugCache.get(file);
    };

    const findings = docs.flatMap(doc => findLinkFindings({ doc, exists, slugsOf, isRecorded: h => recorded.has(h) }));
    const count = docs.reduce((total, doc) => total + linksIn(doc).length, 0);
    let summary = `${count} links in ${docs.length} docs`;

    if (resolve) {
      /** @type {Map<string, { hash: string, url: string, file: string, line: number }>} */
      const proofs = new Map();
      for (const doc of docs) {
        for (const link of linksIn(doc)) {
          const target = classifyTarget(link.target);
          const hash = target.hash?.toLowerCase();
          if (target.mirrorUrl === undefined || hash === undefined || !TRANSACTION_HASH.test(hash)) continue;
          if (!proofs.has(hash)) proofs.set(hash, { hash, url: target.mirrorUrl, file: doc.file, line: link.line });
        }
      }
      const resolved = await resolveProofs([...proofs.values()]);
      findings.push(...resolved.findings);
      summary = [`${summary}; ${proofs.size} read from the mirror node:`, ...resolved.lines].join("\n");
    }
    return resultFrom(findings, summary);
  },
};

if (isMainModule(import.meta.url)) await runCli(check);
