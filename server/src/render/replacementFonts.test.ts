import { test } from "node:test";
import assert from "node:assert/strict";
import { replacementFamily, REPLACEMENT_PREFIX } from "./replacementFonts.ts";
import { applyLayerOverrides } from "./applyLayerOverrides.ts";

test("known metric-compatible families and generic categories", () => {
  for (const [original, expected] of Object.entries({
    "ABCDEF+ArialMT": "Arimo", HelveticaNeue: "Arimo", TimesNewRomanPSMT: "Tinos",
    CourierNew: "Cousine", Calibri: "Carlito", Cambria: "Caladea", LibreCaslonCondensed: "Tinos",
    Montserrat: "Inter", UnknownSans: "Inter",
  })) assert.equal(replacementFamily(original), expected);
  assert.equal(replacementFamily("Unknown", "serif"), "Tinos");
  assert.equal(replacementFamily("Unknown", "mono"), "Cousine");
});

test("all edited PDF subset fields switch as a whole, unchanged fields stay original", () => {
  for (const family of ["ArialMT", "TimesNewRoman", "CourierNew", "Calibri", "Cambria", "Montserrat", "Mystery"]) {
    const el = { type: "text", name: "title", text: "abc", font: family, weight: 700, italic: true };
    const doc = { fonts: [{ family, glyphs: "abc" }], pages: [{ els: [el] }] };
    const unchanged = applyLayerOverrides(doc, { texts: { title: "abc" }, images: {}, hidden: new Set() }, 0);
    assert.deepEqual(unchanged, doc);
    const changed = applyLayerOverrides(doc, { texts: { title: "xyz" }, images: {}, hidden: new Set() }, 0) as typeof doc;
    assert.equal(changed.pages[0].els[0].font, REPLACEMENT_PREFIX + replacementFamily(family));
    assert.equal(changed.pages[0].els[0].italic, true);
    assert.equal(doc.pages[0].els[0].font, family);
  }
});
