import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZip, crc32 } from "./zip.ts";

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("an empty archive is just the end-of-central-directory record", () => {
  const z = buildZip([]);
  assert.equal(z.length, 22);
  assert.equal(new DataView(z.buffer).getUint32(0, true), 0x06054b50);
});

test("unzip reads back every entry byte-for-byte", () => {
  const enc = new TextEncoder();
  const files = [
    { name: "design-01.png", data: enc.encode("primeira página") },
    { name: "design-02.png", data: new Uint8Array([0, 255, 1, 254, 137, 80, 78, 71]) },
  ];
  const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
  const zipPath = join(dir, "out.zip");
  writeFileSync(zipPath, buildZip(files));
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", join(dir, "x")]);
  for (const f of files) assert.deepEqual(new Uint8Array(readFileSync(join(dir, "x", f.name))), f.data);
});
