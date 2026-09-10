import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDesignFonts } from "./designFontLoader.ts";
import type { Doc } from "./types.ts";

test("reopening a complete-font design restores precedence after an older PDF subset", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousFontFace = Object.getOwnPropertyDescriptor(globalThis, "FontFace");
  class Face {
    family: string;
    src: string;
    descriptors: unknown;
    constructor(family: string, src: string, descriptors: unknown) {
      this.family = family; this.src = src; this.descriptors = descriptors;
    }
    async load() { return this; }
  }
  const fonts = new Set<Face>();
  Object.defineProperty(globalThis, "document", { configurable: true, value: { fonts } });
  Object.defineProperty(globalThis, "FontFace", { configurable: true, value: Face });
  try {
    const doc = (sha: string): Doc => ({ name: "test", active: 0, pages: [], fonts: [{ family: "TestFont", weight: 700, style: "italic", sha256: sha, ttf: `${sha}.ttf`, woff2: `${sha}.woff2` }] });
    await loadDesignFonts(doc("complete"));
    await loadDesignFonts(doc("subset"));
    await loadDesignFonts(doc("complete"));
    assert.equal(fonts.size, 2);
    assert.match([...fonts].at(-1)!.src, /complete/);
    assert.deepEqual([...fonts].at(-1)!.descriptors, { weight: "700", style: "italic" });
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (previousFontFace) Object.defineProperty(globalThis, "FontFace", previousFontFace);
    else Reflect.deleteProperty(globalThis, "FontFace");
  }
});
