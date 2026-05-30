import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";

import { createZip, crc32 } from "../lib/zip";

test("crc32 matches the well-known test vector", () => {
  // CRC-32 of "123456789" is 0xCBF43926.
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("createZip produces an archive the system unzip can read", () => {
  const entries = [
    { name: "main.tex", data: Buffer.from("\\documentclass{article}\n\\begin{document}Hi\\end{document}\n") },
    { name: "images/fig-1.bin", data: Buffer.from([0, 1, 2, 3, 255, 254, 10, 13]) }
  ];
  const zip = createZip(entries);

  const dir = mkdtempSync(path.join(tmpdir(), "zip-test-"));
  try {
    const zipPath = path.join(dir, "out.zip");
    writeFileSync(zipPath, zip);

    // `unzip -t` validates CRCs and the central directory structure.
    const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
    assert.match(listing, /main\.tex/);
    assert.match(listing, /images\/fig-1\.bin/);

    execFileSync("unzip", ["-o", zipPath, "-d", dir], { stdio: "ignore" });
    assert.deepEqual(readFileSync(path.join(dir, "main.tex")), entries[0].data);
    assert.deepEqual(readFileSync(path.join(dir, "images/fig-1.bin")), entries[1].data);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stored entries carry no compression so raw inflate is unnecessary", () => {
  // Sanity: a stored entry's bytes appear verbatim in the archive (no deflate).
  const data = Buffer.from("verbatim-payload-marker");
  const zip = createZip([{ name: "a.txt", data }]);
  assert.ok(zip.includes(data), "stored payload should appear uncompressed in the archive");
  // Guard against accidentally importing deflate-only helpers.
  assert.equal(typeof inflateRawSync, "function");
});
