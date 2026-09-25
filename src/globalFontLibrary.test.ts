import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchGlobalFonts, withGlobalFontFamily } from "./globalFontLibrary.ts";
import { loadDesignFonts } from "./designFontLoader.ts";
import type { Doc } from "./types.ts";

test("a fresh catalog fetch lets another design persist and reload an imported font", async (t) => {
  const raw = { internalFamily: "Shared Test", weight: 700, style: "Italic", sha256: "shared-file", sfntPath: "supabase://font-sfnt/shared.ttf", woff2Path: "https://storage.test/shared.woff2" };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/v1/fonts");
    assert.equal(options?.credentials, "include");
    return new Response(JSON.stringify([raw]));
  });
  const catalog = await fetchGlobalFonts();
  const secondDesign: Doc = { name: "Another design", active: 0, pages: [], fonts: withGlobalFontFamily([], catalog, "Shared Test") };
  const reopened: Doc = JSON.parse(JSON.stringify(secondDesign));
  const fonts = new Set();
  class Face {
    family: string; source: string; descriptors: unknown;
    constructor(family: string, source: string, descriptors: unknown) { this.family = family; this.source = source; this.descriptors = descriptors; }
    async load() { return this; }
  }
  const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const beforeFace = Object.getOwnPropertyDescriptor(globalThis, "FontFace");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { fonts } });
  Object.defineProperty(globalThis, "FontFace", { configurable: true, value: Face });
  try {
    await loadDesignFonts(reopened);
    assert.equal(fonts.size, 1);
    assert.deepEqual([...fonts][0], new Face("Shared Test", 'url("https://storage.test/shared.woff2")', { weight: "700", style: "italic" }));
    assert.equal(reopened.fonts?.[0].ttf, raw.sfntPath);
    assert.equal((await fetchGlobalFonts())[0].sha256, raw.sha256);
  } finally {
    if (beforeDocument) Object.defineProperty(globalThis, "document", beforeDocument); else Reflect.deleteProperty(globalThis, "document");
    if (beforeFace) Object.defineProperty(globalThis, "FontFace", beforeFace); else Reflect.deleteProperty(globalThis, "FontFace");
  }
});

test("document font versions win over catalog duplicates; other weights are available", () => {
  const old = { family: "Shared", weight: 400, style: "Regular", sha256: "old", ttf: "old.ttf", woff2: "old.woff2" };
  const fonts = withGlobalFontFamily([old], [{ ...old, sha256: "new", style: "normal" }, { ...old, weight: 700, sha256: "bold" }], "Shared");
  assert.deepEqual(fonts.map(f => f.sha256), ["old", "bold"]);
});

test("a failed global catalog request is not presented as an empty library", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503 }));
  await assert.rejects(fetchGlobalFonts(), /fontes compartilhadas/);
});
