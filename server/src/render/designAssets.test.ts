import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTemplateSvg, listDesignFonts, listImageLayers } from "./editableTweetTemplate.ts";

const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

function docComAsset(src: string) {
  return {
    name: "d", active: 0,
    assets: { fundo: PIXEL },
    pages: [{ id: "p", w: 100, h: 100, bg: "#000", els: [
      { id: "1", type: "image", name: "fundo", x: 0, y: 0, w: 100, h: 100, src },
    ] }],
  };
}

test('listImageLayers resolve "@chave" contra doc.assets — sem isso o src fica sendo a string "@fundo"', () => {
  assert.deepEqual(listImageLayers(docComAsset("@fundo")), [{ name: "fundo", src: PIXEL }]);
});

test("listImageLayers devolve undefined para uma @chave que não existe em assets, em vez da string crua", () => {
  assert.deepEqual(listImageLayers(docComAsset("@sumiu")), [{ name: "fundo", src: undefined }]);
});

test("um src normal passa intacto", () => {
  assert.deepEqual(listImageLayers(docComAsset("https://exemplo.com/a.jpg")),
    [{ name: "fundo", src: "https://exemplo.com/a.jpg" }]);
});

test('achado real: um documento com assets/"@chave" renderizava EM BRANCO — o <image> era descartado por não começar com data:', () => {
  const svg = buildTemplateSvg(docComAsset("@fundo"), { texts: {}, hidden: new Set() }, {});
  assert.ok(svg.includes("<image"), "a camada de imagem tem que aparecer no SVG");
  assert.ok(svg.includes(PIXEL));
});

test("listDesignFonts lê as faces do documento e descarta entrada sem sha256 — sem identidade não há cache confiável", () => {
  const doc = { name: "d", active: 0, pages: [], fonts: [
    { family: "NYTFranklin", weight: 300, sha256: "abc", ttf: "https://e/x.ttf", woff2: "https://e/x.woff2" },
    { family: "SemSha", weight: 400, ttf: "https://e/y.ttf" },
    { family: "SemTtf", weight: 400, sha256: "def" },
    null,
  ] };
  assert.deepEqual(listDesignFonts(doc), [{ family: "NYTFranklin", weight: 300, sha256: "abc", src: "https://e/x.ttf" }]);
});

test("um documento sem fonts não quebra nem inventa faces", () => {
  assert.deepEqual(listDesignFonts({ name: "d", active: 0, pages: [] }), []);
});
