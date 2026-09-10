import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { renderTemplatePng } from "./renderTweet.ts";
import { fixtureDocFont, FIXTURE_FAMILY } from "./__fixtures__/fixtureFont.ts";
import { resolveFaces } from "./resolveFonts.ts";
import { applyLayerOverrides } from "./applyLayerOverrides.ts";
import { builtinFaces } from "./builtinFaces.ts";

const layers = { texts: {}, images: {}, hidden: new Set<string>() };
function documentFor(extra: Record<string, unknown>) {
  return { fonts: [fixtureDocFont()], pages: [{ w: 300, h: 180, bg: "#ffffff", els: [
    { type: "text", name: "title", x: 10, y: 10, w: 202, h: 100, size: 40,
      font: FIXTURE_FAMILY, weight: 400, lh: 1.25, fill: "#000000", text: "AAAAAAAAAA", ...extra },
  ] }] };
}

test("API wraps using font advances, not the average character estimate", async () => {
  const png = await renderTemplatePng(documentFor({}), layers);
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows = new Set<number>();
  for (let p = 0; p < info.width * info.height; p++) {
    if (data[p * info.channels] < 100) rows.add(Math.floor(p / info.width));
  }
  assert.ok(rows.size > 0);
  assert.ok(Math.max(...rows) - Math.min(...rows) < 40, "editor fits ten 20px glyphs in 202px, API must keep one line");
});

test("API preserves rich text foreground colors from the editor", async () => {
  const png = await renderTemplatePng(documentFor({ text: "AB", runs: [
    { text: "A", fill: "#ff0000", italic: true }, { text: "B", fill: "#0000ff" },
  ] }), layers);
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let red = 0, blue = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] > 200 && data[i + 1] < 50 && data[i + 2] < 50) red++;
    if (data[i + 2] > 200 && data[i] < 50 && data[i + 1] < 50) blue++;
  }
  assert.ok(red > 20 && blue > 20, `missing run styles: red=${red}, blue=${blue}`);
});

test("browser accepts complementary subsets of the same family and weight", () => {
  const first = { family: "Imported", weight: 400, sha256: "a", src: "/a.ttf", glyphs: "Title" };
  const second = { ...first, sha256: "b", src: "/b.ttf", glyphs: "Subtitle" };
  assert.deepEqual(resolveFaces([first, second], ["Imported"], true), [first, second]);
});

test("browser preserves four Montserrat 700 faces even without glyph metadata", () => {
  const faces = ["69c1d32f71fb", "21a2339dba21", "247f052d2f5b", "f774b12bcc77"].map(sha256 => ({
    family: "Montserrat", weight: 700, sha256, src: `/${sha256}.ttf`,
  }));
  assert.deepEqual(resolveFaces(faces, ["Montserrat"], true), faces);
  assert.throws(() => resolveFaces(faces, ["Montserrat"]), /Ambíguo/);
});

test("PNG uses the last declared matching face without requiring glyph metadata", async () => {
  const first = { ...fixtureDocFont(700), family: "Montserrat" };
  const inter = builtinFaces().find(face => face.weight === 700)!;
  const last = { family: "Montserrat", weight: 700, sha256: inter.sha256, ttf: inter.src, woff2: "" };
  const base = documentFor({ font: "Montserrat", weight: 700, text: "ABCD" });
  const both = await renderTemplatePng({ ...base, fonts: [first, last] }, layers);
  const expected = await renderTemplatePng({ ...base, fonts: [last] }, layers);
  const reversed = await renderTemplatePng({ ...base, fonts: [last, first] }, layers);
  assert.deepEqual(both, expected);
  assert.notDeepEqual(both, reversed, "declaration order must determine which face renders");
});

test("saved overrides and PNG use the same rich-text content", () => {
  const doc = documentFor({ text: "AB", runs: [{ text: "AB", italic: true }] });
  assert.deepEqual(applyLayerOverrides(doc, { ...layers, texts: { title: "AB" } }, 0), doc);
  const changed = applyLayerOverrides(doc, { ...layers, texts: { title: "CD" } }, 0) as ReturnType<typeof documentFor>;
  assert.equal(changed.pages[0].els[0].text, "CD");
  assert.ok(!("runs" in changed.pages[0].els[0]));
});

test("API preserves the editor's italic style", async () => {
  const normal = await renderTemplatePng(documentFor({ text: "ABCD" }), layers);
  const italic = await renderTemplatePng(documentFor({ text: "ABCD", italic: true }), layers);
  assert.notDeepEqual(normal, italic);
});

test("long replacement text stays inside its authored box", async () => {
  const doc = documentFor({ text: "AB", w: 202, h: 50 });
  const png = await renderTemplatePng(doc, { ...layers, texts: { title: "ABCD ABCD ABCD ABCD ABCD ABCD" } });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let pixels = 0;
  for (let p = 0; p < info.width * info.height; p++) {
    if (data[p * info.channels] >= 100) continue;
    pixels++;
    const y = Math.floor(p / info.width);
    assert.ok(y >= 10 && y < 60, `replacement escaped the authored box at y=${y}`);
  }
  assert.ok(pixels > 0, "fitting must not hide the replacement");
});

test("a saved fitted replacement renders exactly like its API preview", async () => {
  const doc = documentFor({ text: "AB", w: 202, h: 50 });
  const replacements = { ...layers, texts: { title: "ABCD ABCD ABCD ABCD ABCD ABCD" } };
  const preview = await renderTemplatePng(doc, replacements);
  const saved = applyLayerOverrides(doc, replacements, 0);
  const reopened = await renderTemplatePng(saved, layers);
  assert.deepEqual(preview, reopened);
});
