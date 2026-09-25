import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { compress } from "wawoff2";
import { FontUploadError, faceMetadata, toSfnt } from "./fontUpload.ts";
import { normalizeWeight, preferredFamilyName } from "./sfntNames.ts";

const ARIAL_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf";
const ROUNDED = "/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf";
const has = existsSync(ARIAL_BOLD);

/** Encoder WOFF 1.0 mínimo (só para o teste): cada tabela zlib. */
function toWoff1(sfnt: Buffer): Buffer {
  const n = sfnt.readUInt16BE(4);
  const tables = Array.from({ length: n }, (_, i) => {
    const r = 12 + i * 16;
    const off = sfnt.readUInt32BE(r + 8), len = sfnt.readUInt32BE(r + 12);
    const orig = sfnt.subarray(off, off + len), comp = deflateSync(orig);
    return { tag: sfnt.subarray(r, r + 4), checksum: sfnt.readUInt32BE(r + 4), orig, data: comp.length < len ? comp : orig };
  });
  const head = Buffer.alloc(44 + 20 * n);
  head.write("wOFF", 0, "latin1"); head.writeUInt32BE(sfnt.readUInt32BE(0), 4); head.writeUInt16BE(n, 12);
  let off = head.length; const chunks: Buffer[] = [head];
  tables.forEach((t, i) => {
    const r = 44 + i * 20;
    t.tag.copy(head, r); head.writeUInt32BE(off, r + 4); head.writeUInt32BE(t.data.length, r + 8);
    head.writeUInt32BE(t.orig.length, r + 12); head.writeUInt32BE(t.checksum, r + 16);
    const pad = Buffer.alloc((4 - (t.data.length % 4)) % 4);
    chunks.push(t.data, pad); off += t.data.length + pad.length;
  });
  return Buffer.concat(chunks);
}

test("peso na escala antiga 1–9 vira 100–900", () => {
  assert.equal(normalizeWeight(5), 500);
  assert.equal(normalizeWeight(700), 700);
  assert.equal(normalizeWeight(0), null);
});

test("coleção .ttc e arquivo que não é fonte dão mensagem clara", async () => {
  await assert.rejects(toSfnt(Buffer.from("ttcf0000")), (e: Error) => e instanceof FontUploadError && /coleção/.test(e.message));
  await assert.rejects(toSfnt(Buffer.from("%PDF-1.7")), (e: Error) => e instanceof FontUploadError && /não parece ser uma fonte/.test(e.message));
});

test("ttf, woff2 e woff chegam ao mesmo SFNT e aos mesmos metadados", { skip: !has }, async () => {
  const ttf = readFileSync(ARIAL_BOLD);
  const direct = await toSfnt(ttf);
  const viaWoff2 = await toSfnt(Buffer.from(await compress(ttf)));
  const viaWoff = await toSfnt(toWoff1(ttf));
  for (const r of [direct, viaWoff2, viaWoff]) assert.deepEqual(faceMetadata(r.sfnt), { family: "Arial", weight: 700, style: "Regular" });
  assert.equal(viaWoff.sfnt.length >= ttf.length - 16, true);
});

test("só corta o estilo do nome quando o arquivo confirma o peso", { skip: !existsSync(ROUNDED) }, () => {
  assert.equal(preferredFamilyName(readFileSync(ROUNDED)), "Arial Rounded MT Bold");
});

test("família do formulário prevalece (completar a família do design)", { skip: !has }, async () => {
  const { sfnt } = await toSfnt(readFileSync(ARIAL_BOLD));
  assert.equal(faceMetadata(sfnt, { family: "New Spirit" }).family, "New Spirit");
});
