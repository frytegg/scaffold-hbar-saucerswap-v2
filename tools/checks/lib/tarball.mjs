// @ts-check
import { gunzipSync } from "node:zlib";

const BLOCK = 512;
const REGULAR_FILE = new Set(["0", "\0"]);
/** Entries that carry the full name of the entry that follows them, for names longer than the header holds. */
const PAX_HEADER = "x";
const GNU_LONG_NAME = "L";

/**
 * @param {Buffer} block
 * @param {number} start
 * @param {number} length
 * @returns {string} a NUL-terminated header field
 */
function field(block, start, length) {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

/**
 * @param {Buffer} content the records of a PAX extended header, `<length> <key>=<value>` per line
 * @returns {string | undefined}
 */
function paxPath(content) {
  for (const record of content.toString("utf8").split("\n")) {
    const path = /^\d+ path=(.*)$/.exec(record)?.[1];
    if (path !== undefined) return path;
  }
  return undefined;
}

/**
 * Reads the regular files of a gzipped tar archive, as registry tarballs lay them out: ustar headers, with PAX or
 * GNU headers for long names.
 * @param {Buffer} tgz
 * @returns {Map<string, Buffer>} path inside the archive to content
 */
export function readTarball(tgz) {
  const tar = gunzipSync(tgz);
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  /** @type {string | undefined} */
  let longName;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    if (Number.isNaN(size)) throw new Error(`corrupt tar header at byte ${offset}`);
    const content = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    if (content.length < size) throw new Error(`truncated tar archive: entry at byte ${offset} runs past the end`);

    const type = String.fromCharCode(header[156]);
    if (type === PAX_HEADER) {
      longName = paxPath(content) ?? longName;
    } else if (type === GNU_LONG_NAME) {
      longName = field(content, 0, content.length);
    } else {
      const prefix = field(header, 345, 155);
      const name = field(header, 0, 100);
      if (REGULAR_FILE.has(type)) files.set(longName ?? (prefix ? `${prefix}/${name}` : name), content);
      longName = undefined;
    }
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
