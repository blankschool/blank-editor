import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FONT_LIBRARY, FONT_CATEGORIES, PRELOADED_FAMILIES,
  catalogStylesheetUrls, designFamilies, fontLabel, fontStylesheetUrl, localFontFaceCss, searchFontLibrary,
} from "./fontLibrary.ts";

test("every family in the catalogue is unique and belongs to a listed category", () => {
  const names = FONT_LIBRARY.map((f) => f.family);
  assert.equal(new Set(names).size, names.length);
  const categories = new Set(FONT_CATEGORIES.map((c) => c.id));
  for (const font of FONT_LIBRARY) {
    assert.ok(categories.has(font.category), `${font.family} has an unlisted category`);
    assert.ok(font.weights.length > 0, `${font.family} has no weights`);
  }
});

test("every preloaded family is actually in the catalogue", () => {
  for (const family of PRELOADED_FAMILIES) {
    assert.ok(FONT_LIBRARY.some((f) => f.family === family), `${family} is preloaded but not offered`);
  }
});

test("search ignores case and accents so \"grotesk\" and \"MONTSERRAT\" both land", () => {
  assert.deepEqual(searchFontLibrary({ query: "grotesk" }).map((f) => f.family), ["Space Grotesk"]);
  assert.deepEqual(searchFontLibrary({ query: "MONTSERRAT" }).map((f) => f.family), ["Montserrat"]);
});

test("a category narrows the list, and combines with the query", () => {
  const serif = searchFontLibrary({ category: "serif" });
  assert.ok(serif.length > 1);
  assert.ok(serif.every((f) => f.category === "serif"));
  assert.deepEqual(searchFontLibrary({ query: "playfair", category: "serif" }).map((f) => f.family), ["Playfair Display"]);
  assert.deepEqual(searchFontLibrary({ query: "playfair", category: "mono" }), []);
});

test("an empty search returns the whole catalogue", () => {
  assert.equal(searchFontLibrary().length, FONT_LIBRARY.length);
  assert.equal(searchFontLibrary({ query: "   " }).length, FONT_LIBRARY.length);
});

test("the design's own families are the ones the catalogue does not already offer", () => {
  assert.deepEqual(
    designFamilies(["Libre Caslon Condensed", "Montserrat", undefined, "Libre Caslon Condensed", "AAAAAA+PanicoSans"]),
    ["Libre Caslon Condensed", "AAAAAA+PanicoSans"],
  );
});

test("a replacement face is labelled by its bare family name", () => {
  assert.equal(fontLabel("Blank Complete Libre Caslon Condensed"), "Libre Caslon Condensed");
  assert.equal(fontLabel("Montserrat"), "Montserrat");
});

test("a stylesheet URL carries the weight axis only when it is not plain 400", () => {
  assert.equal(
    fontStylesheetUrl({ family: "Space Grotesk", category: "sans", weights: [700, 400] }),
    "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&display=swap",
  );
  assert.equal(
    fontStylesheetUrl({ family: "Anton", category: "display", weights: [400] }),
    "https://fonts.googleapis.com/css2?family=Anton&display=swap",
  );
});

test("the catalogue is fetched in batches, skipping what index.html already loads", () => {
  const urls = catalogStylesheetUrls();
  const requested = urls.flatMap((u) => [...u.matchAll(/family=([^&:]+)/g)].map((m) => decodeURIComponent(m[1]).replace(/\+/g, " ")));
  for (const family of PRELOADED_FAMILIES) assert.ok(!requested.includes(family), `${family} should not be refetched`);
  assert.deepEqual(
    [...requested].sort(),
    FONT_LIBRARY.filter((f) => !f.files).map((f) => f.family).filter((f) => !PRELOADED_FAMILIES.includes(f)).sort(),
  );
  assert.ok(urls.every((u) => u.length < 2000), "a stylesheet URL grew past what a server will accept");
});

test("a self-hosted family declares its own faces and never asks Google for a stylesheet", () => {
  const chirp = FONT_LIBRARY.find((f) => f.family === "Chirp");
  assert.ok(chirp?.files?.length, "Chirp should carry its own files");
  assert.deepEqual(chirp!.weights, chirp!.files!.map((file) => file.weight));

  const css = localFontFaceCss();
  for (const file of chirp!.files!) {
    assert.match(css, new RegExp(`font-weight:${file.weight};[^}]*${file.url.replace(/\//g, "\\/")}`));
  }
  assert.ok(!catalogStylesheetUrls().some((u) => u.includes("Chirp")));
  assert.equal(localFontFaceCss(FONT_LIBRARY.filter((f) => !f.files)), "");
});
