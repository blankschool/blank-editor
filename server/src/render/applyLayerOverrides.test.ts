import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLayerOverrides } from "./applyLayerOverrides.ts";
import type { ParsedLayers } from "./layers.ts";

function layers(texts: Record<string, string> = {}, images: Record<string, string> = {}, hidden: string[] = []): ParsedLayers {
  return { texts, images, hidden: new Set(hidden) };
}

const SINGLE_PAGE = {
  active: 0,
  pages: [
    {
      w: 100,
      h: 100,
      bg: "#000",
      els: [
        { id: "a", type: "text", name: "titulo", text: "original", x: 0, y: 0 },
        { id: "b", type: "image", name: "foto", src: "https://example.com/original.jpg", x: 0, y: 0 },
        { id: "c", type: "rect", name: "faixa", x: 0, y: 0 }, // sem override correspondente — deve ficar intocado
      ],
    },
  ],
};

test("sobrescreve só o text/src dos elementos nomeados na página resolvida", () => {
  const result = applyLayerOverrides(SINGLE_PAGE, layers({ titulo: "novo título" }, { foto: "https://example.com/nova.jpg" }), undefined) as typeof SINGLE_PAGE;
  const els = result.pages[0].els;
  assert.equal(els[0].text, "novo título");
  assert.equal((els[1] as { src: string }).src, "https://example.com/nova.jpg");
  assert.deepEqual(els[2], SINGLE_PAGE.pages[0].els[2]); // elemento sem override, idêntico
});

test("um nome de camada que não existe no documento não gera erro nem entra no resultado", () => {
  const result = applyLayerOverrides(SINGLE_PAGE, layers({ campoQueNaoExiste: "x" }), undefined) as typeof SINGLE_PAGE;
  assert.deepEqual(result.pages[0].els[0].text, "original");
});

test("hidden do request nunca é persistido — o elemento continua no documento salvo", () => {
  const result = applyLayerOverrides(SINGLE_PAGE, layers({}, {}, ["titulo"]), undefined) as typeof SINGLE_PAGE;
  assert.equal(result.pages[0].els[0].text, "original");
  assert.ok(result.pages[0].els.some((el) => el.name === "titulo"));
});

test("três chamadas com páginas diferentes coalescem: cada save só toca a página daquela chamada", () => {
  const carrossel = {
    active: 0,
    pages: [
      { w: 10, h: 10, bg: "#000", els: [{ id: "1", type: "text", name: "titulo", text: "p1" }] },
      { w: 10, h: 10, bg: "#000", els: [{ id: "2", type: "text", name: "titulo", text: "p2" }] },
      { w: 10, h: 10, bg: "#000", els: [{ id: "3", type: "text", name: "titulo", text: "p3" }] },
    ],
  };

  let doc: unknown = carrossel;
  doc = applyLayerOverrides(doc, layers({ titulo: "capa nova" }), 0);
  doc = applyLayerOverrides(doc, layers({ titulo: "ponto 1 novo" }), 1);
  doc = applyLayerOverrides(doc, layers({ titulo: "ponto 2 novo" }), 2);

  const result = doc as typeof carrossel;
  assert.equal(result.pages[0].els[0].text, "capa nova");
  assert.equal(result.pages[1].els[0].text, "ponto 1 novo");
  assert.equal(result.pages[2].els[0].text, "ponto 2 novo");
});

test("sem pageIndex explícito, usa a página `active` do documento", () => {
  const doc = { active: 1, pages: [{ els: [{ name: "t", type: "text", text: "a" }] }, { els: [{ name: "t", type: "text", text: "b" }] }] };
  const result = applyLayerOverrides(doc, layers({ t: "mudou" }), undefined) as typeof doc;
  assert.equal(result.pages[0].els[0].text, "a"); // página 0 intocada
  assert.equal(result.pages[1].els[0].text, "mudou"); // active=1 é a que foi tocada
});

test("documento sem pages devolve o documento original, sem quebrar", () => {
  const doc = { foo: "bar" };
  const result = applyLayerOverrides(doc, layers({ x: "y" }), undefined);
  assert.deepEqual(result, doc);
});
