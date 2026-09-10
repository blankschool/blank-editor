import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { renderTemplatePng } from "./renderTweet.ts";
import { fixtureDocFont, FIXTURE_FAMILY } from "./__fixtures__/fixtureFont.ts";
import { resolveFaces } from "./resolveFonts.ts";
import { applyLayerOverrides } from "./applyLayerOverrides.ts";

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
