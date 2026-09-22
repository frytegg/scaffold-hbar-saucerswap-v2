// @ts-check

/** @typedef {{ line: number, text: string }} LineText */
/** @typedef {{ line: number, info: string, lines: string[] }} Fence `line` is the first content line */
/** @typedef {{ line: number, level: number, title: string }} Heading */
/**
 * @typedef {object} MarkdownDoc
 * @property {string} file
 * @property {string[]} lines
 * @property {LineText[]} spans inline code spans outside fences
 * @property {Fence[]} fences
 * @property {LineText[]} prose lines outside fences, with inline code blanked out
 * @property {Heading[]} headings
 * @property {Map<string, Set<string>>} allow deliberate exceptions declared in the doc, by kind
 */

const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;
const CODE_SPAN = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ALLOW_BLOCK = /<!--\s*checks:allow\b([\s\S]*?)-->/g;

/**
 * Line-based Markdown reader: enough structure for the checks, no rendering.
 * @param {string} file
 * @param {string} text
 * @returns {MarkdownDoc}
 */
export function parseMarkdown(file, text) {
  const lines = text.split(/\r?\n/);
  /** @type {MarkdownDoc} */
  const doc = { file, lines, spans: [], fences: [], prose: [], headings: [], allow: new Map() };
  /** @type {{ marker: string, fence: Fence } | undefined} */
  let open;
  /** @type {string[]} */
  const outsideFences = [];

  lines.forEach((content, index) => {
    const line = index + 1;
    if (open) {
      const closing = content.trim();
      if (closing.startsWith(open.marker) && /^(`+|~+)$/.test(closing)) open = undefined;
      else open.fence.lines.push(content);
      return;
    }
    const opening = FENCE_OPEN.exec(content);
    if (opening) {
      const fence = { line: line + 1, info: opening[2].trim(), lines: [] };
      doc.fences.push(fence);
      open = { marker: opening[1], fence };
      return;
    }
    const heading = HEADING.exec(content);
    if (heading) doc.headings.push({ line, level: heading[1].length, title: heading[2] });
    for (const span of content.matchAll(CODE_SPAN)) doc.spans.push({ line, text: span[2].trim() });
    doc.prose.push({ line, text: content.replace(CODE_SPAN, match => " ".repeat(match.length)) });
    outsideFences.push(content);
  });
  doc.allow = parseAllowBlocks(outsideFences.join("\n"));
  return doc;
}

/**
 * Reads `<!-- checks:allow … -->` blocks: one `kind: token token` entry per line.
 * @param {string} text the doc without its fenced blocks, where such a comment is an example
 * @returns {Map<string, Set<string>>}
 */
function parseAllowBlocks(text) {
  /** @type {Map<string, Set<string>>} */
  const allow = new Map();
  for (const block of text.matchAll(ALLOW_BLOCK)) {
    for (const entry of block[1].split(/\r?\n/)) {
      const parts = /^\s*([a-z]+)\s*:\s*(.+)$/.exec(entry);
      if (!parts) continue;
      const tokens = allow.get(parts[1]) ?? new Set();
      for (const token of parts[2].split(/[\s,]+/).filter(Boolean)) tokens.add(token);
      allow.set(parts[1], tokens);
    }
  }
  return allow;
}

/**
 * Tracks which allowlist entries were needed, so that a stale entry is reported instead of lingering.
 * @param {MarkdownDoc} doc
 * @param {string} kind
 */
export function createAllowlist(doc, kind) {
  const declared = doc.allow.get(kind) ?? new Set();
  /** @type {Set<string>} */
  const used = new Set();
  return {
    /** @param {string} token */
    permits(token) {
      if (!declared.has(token)) return false;
      used.add(token);
      return true;
    },
    /** @returns {import("./report.mjs").Finding[]} */
    staleEntries() {
      return [...declared]
        .filter(token => !used.has(token))
        .map(token => ({
          file: doc.file,
          message: `allowlist entry "${kind}: ${token}" excuses nothing in this file: remove it`,
        }));
    },
  };
}

/**
 * Every line of code a doc shows: inline spans and the content of fenced blocks.
 * @param {MarkdownDoc} doc
 * @returns {LineText[]}
 */
export function codeLines(doc) {
  const fenced = doc.fences.flatMap(fence => fence.lines.map((text, offset) => ({ line: fence.line + offset, text })));
  return [...doc.spans, ...fenced];
}

/**
 * @param {MarkdownDoc} doc
 * @param {RegExp} title
 * @returns {{ from: number, to: number }[]} line ranges of the sections whose heading matches
 */
export function sectionsTitled(doc, title) {
  return doc.headings
    .filter(heading => title.test(heading.title))
    .map(heading => {
      const next = doc.headings.find(other => other.line > heading.line && other.level <= heading.level);
      return { from: heading.line, to: next ? next.line - 1 : doc.lines.length };
    });
}
