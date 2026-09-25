import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFontToOriginal, missingPdfFonts } from "./missingFonts.ts";

const txt = (font: string, fontOriginal?: string) => ({ type: "text", font, ...(fontOriginal ? { fontOriginal } : {}) });
const pages = () => [{ els: [txt("Inter", "NewSpirit"), txt("Inter", "NewSpirit-SemiBold"), txt("DM Sans"), txt("Montserrat", "DMSans")] }] as any;

test("lista cada família do PDF que ficou com substituta, uma vez", () => {
  assert.deepEqual(missingPdfFonts(pages()), [
    { family: "NewSpirit", count: 2, replacement: "Inter" },
    { family: "DMSans", count: 1, replacement: "Montserrat" },
  ]);
});

test("fonte adicionada troca a substituta em todas as caixas daquela família", () => {
  const p = pages();
  assert.equal(applyFontToOriginal(p, "NewSpirit", "New Spirit"), 2);
  assert.deepEqual(missingPdfFonts(p).map((m) => m.family), ["DMSans"]);
  assert.equal(p[0].els[0].font, "New Spirit");
});

import { missingWeights } from "./missingFonts.ts";

test("aponta os pesos usados que a família ainda não tem", () => {
  const pages = [{ els: [
    { type: "text", font: "New Spirit", weight: 400, runs: [{ text: "a" }, { text: "b", weight: 700 }, { text: "c", italic: true }] },
    { type: "text", font: "Inter", weight: 700 },
  ] }] as any;
  assert.deepEqual(missingWeights(pages, [{ family: "New Spirit", weight: 400, style: "normal" }]),
    [{ family: "New Spirit", missing: ["Bold", "Italic"] }]);
});
