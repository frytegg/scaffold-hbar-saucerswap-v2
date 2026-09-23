// @ts-check
import { parseMarkdown } from "./lib/markdown.mjs";
import { isMainModule, resultFrom, runCli, skipped } from "./lib/report.mjs";
import { listDocs, listTrackedFiles, readJson, readText } from "./lib/repo.mjs";

/**
 * @typedef {object} EvidenceTransaction
 * @property {"approve" | "swap" | "deploy"} role
 * @property {string} result
 * @property {string} feeTinybar
 * @property {string} previewFeeTinybar
 * @property {string} senderNetTinybar
 */
/**
 * @typedef {object} EvidenceRecord the fields of a docs/evidence/ record that the docs quote
 * @property {string} recordedAt
 * @property {{ viem: string, relay: string }} software
 * @property {{ direction: "hbar-to-token" | "token-to-hbar", amountIn: string, amountOut: string, tokenOut: string, summary: string, via?: { contract: string } }} swap
 * @property {EvidenceTransaction[]} transactions
 */

const EVIDENCE_FILE = /^docs\/evidence\/(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.json$/;
const EVIDENCE_MENTION = /docs\/evidence\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.json/g;
const BLOCK_START = "<!-- checks:evidence -->";
const BLOCK_END = "<!-- /checks:evidence -->";
const TINYBAR_PER_HBAR = 100_000_000n;
const MONTHS = ["Jan", "Feb", "March", "April", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];

/**
 * @param {bigint} tinybar
 * @returns {string} the amount in HBAR, without trailing zeros, as the evidence run formats it
 */
function formatHbar(tinybar) {
  const sign = tinybar < 0n ? "-" : "";
  const amount = tinybar < 0n ? -tinybar : tinybar;
  const fraction = (amount % TINYBAR_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return `${sign}${amount / TINYBAR_PER_HBAR}${fraction === "" ? "" : `.${fraction}`}`;
}

/**
 * @param {string[]} items
 * @returns {string}
 */
function joined(items) {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * @param {string} isoTimestamp
 * @returns {string} "22 Sept 2026"
 */
function dayOf(isoTimestamp) {
  const date = new Date(isoTimestamp);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * The block of a doc that quotes a set of evidence files: what one run cost and what it moved, every figure read
 * from the files. The approval approves exactly the swap's input, as the evidence run does.
 * @param {{ file: string, record: EvidenceRecord }[]} evidence in the order the block names the files
 * @returns {{ lines: string[], problems: string[] }} the block's expected lines, and what the files do not support
 */
export function renderEvidenceBlock(evidence) {
  const records = evidence.map(({ record }) => record);
  const distinct = (/** @type {string[]} */ values) => [...new Set(values)];
  const lines = [
    `What one run cost, measured on ${joined(distinct(records.map(record => dayOf(record.recordedAt))))} through ` +
      `${joined(distinct(records.map(record => record.software.relay)))} with viem ` +
      `${joined(distinct(records.map(record => record.software.viem)))} ` +
      `(${joined(evidence.map(({ file }) => `\`${file}\``))}):`,
    "",
    "| transaction | network fee | cost preview shown before signing | outcome |",
    "| --- | --- | --- | --- |",
  ];
  let fees = 0n;
  let net = 0n;
  let hbarIn = 0n;
  let hbarOut = 0n;
  for (const record of records) {
    const [input, output] = record.swap.summary.split(" -> ");
    const outcome = record.swap.direction === "token-to-hbar" ? `${output}, native` : output;
    const outSymbol = record.swap.tokenOut.split(" ")[0];
    for (const transaction of record.transactions) {
      // A deployment is sent with a fixed gas limit and shows no estimate, so its preview is that limit at the gas
      // price of the day. The doc that quotes the block says so; the figure still comes from the record.
      const deployed = record.swap.via?.contract ?? "the contract";
      const what =
        transaction.role === "approve"
          ? `approve ${input} for the router`
          : transaction.role === "deploy"
            ? `deploy ${deployed}`
            : `swap ${input} for ${outSymbol}`;
      const result =
        transaction.role === "approve"
          ? "returned `true`"
          : transaction.role === "deploy"
            ? `\`${transaction.result}\``
            : outcome;
      const preview = formatHbar(BigInt(transaction.previewFeeTinybar));
      lines.push(
        `| ${what} | ${formatHbar(BigInt(transaction.feeTinybar))} HBAR | up to ${preview} HBAR | ${result} |`,
      );
      fees += BigInt(transaction.feeTinybar);
      net += BigInt(transaction.senderNetTinybar);
    }
    if (record.swap.direction === "hbar-to-token") hbarIn += BigInt(record.swap.amountIn);
    else hbarOut += BigInt(record.swap.amountOut);
  }

  const problems = [];
  const movement = net <= 0n ? `fell by ${formatHbar(-net)} HBAR` : `rose by ${formatHbar(net)} HBAR`;
  const swapped = hbarIn === 0n ? "" : ` plus the ${formatHbar(hbarIn)} HBAR swapped`;
  const received = hbarOut === 0n ? "" : ` minus the ${formatHbar(hbarOut)} HBAR received`;
  if (fees + hbarIn - hbarOut !== -net) {
    problems.push(
      `the records' net HBAR movement (${formatHbar(net)}) is not their fees plus the HBAR swapped minus the HBAR ` +
        "received: some other transfer moved HBAR, and the block's last sentence would be false",
    );
  }
  lines.push(
    "",
    `${formatHbar(fees)} HBAR of fees in all; the account's HBAR balance ${movement}, the fees${swapped}${received}.`,
  );
  return { lines, problems };
}

/**
 * @param {string[]} tracked
 * @returns {Map<string, string>} the newest evidence file of each scenario name, by name
 */
export function newestEvidence(tracked) {
  /** @type {Map<string, string>} */
  const newest = new Map();
  for (const file of tracked) {
    const match = EVIDENCE_FILE.exec(file);
    if (!match) continue;
    const current = newest.get(match[2]);
    if (current === undefined || current < file) newest.set(match[2], file);
  }
  return newest;
}

/**
 * @param {import("./lib/markdown.mjs").MarkdownDoc} doc
 * @param {Map<string, string>} newest
 * @param {(file: string) => EvidenceRecord | undefined} readRecord undefined when the file is not in the repository
 * @returns {import("./lib/report.mjs").Finding[]}
 */
export function inspectDoc(doc, newest, readRecord) {
  /** @type {import("./lib/report.mjs").Finding[]} */
  const findings = [];
  doc.lines.forEach((text, index) => {
    for (const [file] of text.matchAll(EVIDENCE_MENTION)) {
      const name = /** @type {RegExpExecArray} */ (EVIDENCE_FILE.exec(file))[2];
      const latest = newest.get(name);
      if (latest !== undefined && latest !== file) {
        findings.push({
          file: doc.file,
          line: index + 1,
          message: `names ${file}, but ${latest} is newer: quote the newest record of each scenario`,
        });
      }
    }
  });

  let start = doc.lines.indexOf(BLOCK_START);
  while (start !== -1) {
    const end = doc.lines.indexOf(BLOCK_END, start + 1);
    if (end === -1) {
      findings.push({ file: doc.file, line: start + 1, message: `${BLOCK_START} has no ${BLOCK_END} after it` });
      break;
    }
    findings.push(...inspectBlock(doc, start, end, readRecord));
    start = doc.lines.indexOf(BLOCK_START, end + 1);
  }
  return findings;
}

/**
 * @param {import("./lib/markdown.mjs").MarkdownDoc} doc
 * @param {number} start index of the opening marker
 * @param {number} end index of the closing marker
 * @param {(file: string) => EvidenceRecord | undefined} readRecord
 * @returns {import("./lib/report.mjs").Finding[]}
 */
function inspectBlock(doc, start, end, readRecord) {
  const actual = doc.lines.slice(start + 1, end);
  const files = [...new Set(actual.flatMap(text => [...text.matchAll(EVIDENCE_MENTION)].map(([file]) => file)))];
  if (files.length === 0) {
    return [{ file: doc.file, line: start + 1, message: "the evidence block names no docs/evidence/ file" }];
  }
  const evidence = [];
  for (const file of files) {
    const record = readRecord(file);
    if (record === undefined) {
      return [{ file: doc.file, line: start + 1, message: `the evidence block quotes ${file}, which is not tracked` }];
    }
    evidence.push({ file, record });
  }

  const { lines: expected, problems } = renderEvidenceBlock(evidence);
  const findings = problems.map(problem => ({ file: doc.file, line: start + 1, message: problem }));
  const length = Math.max(actual.length, expected.length);
  for (let offset = 0; offset < length; offset += 1) {
    if (actual[offset] === expected[offset]) continue;
    findings.push({
      file: doc.file,
      line: start + 2 + offset,
      message:
        expected[offset] === undefined
          ? "this line is not part of the figures the evidence files give: move it out of the block"
          : `differs from ${joined(files)}; the files give: ${expected[offset]}`,
    });
  }
  return findings;
}

/** @type {import("./lib/report.mjs").Check} */
export const check = {
  name: "check-evidence",
  run({ repoRoot }) {
    const tracked = listTrackedFiles(repoRoot);
    const newest = newestEvidence(tracked);
    if (newest.size === 0) return skipped("no docs/evidence/ record in the repository");
    const trackedSet = new Set(tracked);
    /** @param {string} file */
    const readRecord = file =>
      trackedSet.has(file) ? /** @type {EvidenceRecord} */ (readJson(repoRoot, file)) : undefined;
    const docs = listDocs(tracked).map(file => parseMarkdown(file, readText(repoRoot, file)));
    const findings = docs.flatMap(doc => inspectDoc(doc, newest, readRecord));
    return resultFrom(findings, `${newest.size} evidence scenarios quoted in ${docs.length} docs`);
  },
};

if (isMainModule(import.meta.url)) await runCli(check);
