import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createImportFontResolver, fontFamilyKey } from "./importFontResolver.ts";
import { createRequire } from "node:module";
import { renderTemplatePng } from "./renderTweet.ts";
import { applyLayerOverrides } from "./applyLayerOverrides.ts";
import sharp from "sharp";

test("Fontsource resolves PDF names, exact weights and italic without network", async () => {
  const resolve = createImportFontResolver({ catalog: async () => { throw new Error("offline"); } });
  for (const family of ["ABCDEF+Montserrat-BoldItalic", "LibreCaslonCondensed-Italic"]) {
    const face = await resolve({ family, weight: 700, italic: true, text: "Olá, ação! 123" });
    assert.ok(face);
    assert.equal(face.source, "fontsource");
    assert.equal(face.style, "italic");
    assert.equal(face.weight, 700);
    assert.equal(face.bytes.subarray(0, 4).toString(), "wOF2");
  }
  assert.equal(fontFamilyKey("ABCDEF+OpenSans-SemiBold"), "opensans");
});

test("Fontsource italic renders nonblank and Playground edits match the saved editor document", async () => {
  const face = await createImportFontResolver()({ family: "LibreCaslonCondensed", weight: 400, italic: true, text: "Olá" });
  assert.ok(face);
  const path = createRequire(import.meta.url).resolve("@fontsource/libre-caslon-condensed/files/libre-caslon-condensed-latin-400-italic.woff2");
  const doc = { active: 0, fonts: [{ family: face.family, weight: face.weight, style: face.style, sha256: face.sha256, ttf: path, subset: false }],
    pages: [{ w: 480, h: 180, bg: "#000000", els: [{ type: "text", name: "title", font: face.family, weight: 400, italic: true,
      x: 20, y: 20, w: 440, h: 120, size: 54, lh: 1.25, fill: "#ffffff", text: "Olá", autoFit: true }] }] };
  const layers = { texts: { title: "O Pânico na Band encerrou faz 9 anos" }, images: {}, hidden: new Set<string>() };
  const edited = applyLayerOverrides(doc, layers, 0) as typeof doc;
  assert.equal(edited.pages[0].els[0].font, face.family);
  assert.equal(edited.pages[0].els[0].italic, true);
  const api = await renderTemplatePng(doc, layers);
  const saved = await renderTemplatePng(edited, { texts: {}, images: {}, hidden: new Set() });
  assert.deepEqual(api, saved);
  const stats = await sharp(api).stats();
  assert.ok(stats.channels[0].max > 200);
  assert.ok(stats.channels[0].mean > 1);
});

test("Google catalog selects exact variant, caches downloads, rejects missing styles", async () => {
  let requests = 0;
  const bytes = await readFile(new URL("./fonts/complete/Tinos-BoldItalic.ttf", import.meta.url));
  const resolve = createImportFontResolver({
    catalog: async () => [{ family: "Tinos", files: { "700italic": "https://fonts.gstatic.com/test.ttf" } }],
    download: async () => { requests++; return bytes; },
  });
  const request = { family: "ABCDEF+Tinos-BoldItalic", weight: 700, italic: true, text: "Olá" };
  const first = await resolve(request);
  assert.equal(first?.source, "google-fonts");
  assert.equal(first?.family, "Tinos");
  assert.equal((await resolve({ ...request, text: "Novo texto" }))?.sha256, first?.sha256);
  assert.equal(requests, 1);
  assert.equal(await resolve({ ...request, italic: false }), null);
  assert.equal(await resolve({ ...request, text: "漢字" }), null);
});
