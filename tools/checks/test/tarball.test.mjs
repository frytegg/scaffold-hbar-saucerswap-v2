// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { readTarball } from "../lib/tarball.mjs";

/**
 * @param {string} name
 * @param {string} content
 * @param {string} [type] the type flag: "0" for a regular file
 * @returns {Buffer} one ustar entry: header block, then the content padded to a full block
 */
function tarEntry(name, content, type = "0") {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, "utf8");
  header.write(`${Buffer.byteLength(content).toString(8).padStart(11, "0")}\0`, 124, "utf8");
  header.write(type, 156, "utf8");
  const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512);
  body.write(content, 0, "utf8");
  return Buffer.concat([header, body]);
}

/** @param {Buffer[]} entries */
function archive(...entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

test("regular files are read from a gzipped tar archive; other entries are left out", () => {
  const files = readTarball(
    archive(tarEntry("package/dist/", "", "5"), tarEntry("package/dist/cli.js", "export {};\n")),
  );
  assert.deepEqual([...files.keys()], ["package/dist/cli.js"]);
  assert.equal(files.get("package/dist/cli.js")?.toString("utf8"), "export {};\n");
});

test("a name longer than the header holds is taken from the PAX or GNU entry before it, and for that entry only", () => {
  const paxName = `package/${"v4/".repeat(40)}index.cjs`;
  const gnuName = `package/${"src/".repeat(30)}index.ts`;
  const record = ` path=${paxName}\n`;
  // The length prefix counts its own three digits.
  const pax = `${record.length + 3}${record}`;
  const files = readTarball(
    archive(
      tarEntry("PaxHeader/index.cjs", pax, "x"),
      tarEntry(paxName, "pax"),
      tarEntry("././@LongLink", `${gnuName}\0`, "L"),
      tarEntry(gnuName, "gnu"),
      tarEntry("package/package.json", "{}"),
    ),
  );
  assert.deepEqual([...files.keys()], [paxName, gnuName, "package/package.json"]);
});

test("an archive cut short is refused instead of yielding a partial file", () => {
  const cut = tarEntry("package/dist/cli.js", "x".repeat(2000)).subarray(0, 1024);
  assert.throws(() => readTarball(gzipSync(cut)), /truncated tar archive/);
});
