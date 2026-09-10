import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeLayerNames, uniqueLayerName } from "./layerNames.ts";
import type { Doc } from "./types";

const docWith = (...pages: string[][]): Doc =>
  ({ pages: pages.map((names) => ({ els: names.map((name, i) => ({ id: `e${i}`, type: "text", name })) })) }) as unknown as Doc;

test("um nome livre passa intacto; um já usado ganha o primeiro sufixo livre", () => {
  assert.equal(uniqueLayerName("Texto", []), "Texto");
  assert.equal(uniqueLayerName("Texto", ["Texto"]), "Texto 2");
  assert.equal(uniqueLayerName("Texto", ["Texto", "Texto 2", "Texto 4"]), "Texto 3");
});

test("a primeira ocorrência mantém o nome — quem já chama a API por ele continua acertando", () => {
  const doc = docWith(["Texto", "Texto", "Texto"]);
  assert.deepEqual(dedupeLayerNames(doc), [
    { page: 0, from: "Texto", to: "Texto 2" },
    { page: 0, from: "Texto", to: "Texto 3" },
  ]);
  assert.deepEqual(doc.pages[0].els.map((e) => e.name), ["Texto", "Texto 2", "Texto 3"]);
});

test("o mesmo nome em páginas diferentes é o padrão de carrossel, e continua valendo", () => {
  const doc = docWith(["Título"], ["Título"]);
  assert.deepEqual(dedupeLayerNames(doc), []);
  assert.deepEqual(doc.pages.map((p) => p.els[0].name), ["Título", "Título"]);
});

test("um documento já sem duplicatas não muda nada", () => {
  const doc = docWith(["Título", "Subtítulo"]);
  assert.deepEqual(dedupeLayerNames(doc), []);
});
