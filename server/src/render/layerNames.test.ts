import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalLayerNames, dedupeLayerNames, uniqueLayerName } from "./layerNames.ts";
import { applyLayerOverrides } from "./applyLayerOverrides.ts";

const docWith = (...pages: string[][]) =>
  ({ pages: pages.map((names) => ({ els: names.map((name, i) => ({ id: `e${i}`, type: "text", text: "", name })) })) });

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

test("os nomes que a API expõe numa página são únicos mesmo com o documento salvo repetido", () => {
  assert.deepEqual(canonicalLayerNames({ els: [{ name: "Texto" }, { name: "Texto" }, { name: "Imagem" }] }),
    ["Texto", "Texto 2", "Imagem"]);
  assert.deepEqual(canonicalLayerNames({ els: [{}, { name: "Texto" }] }), ["", "Texto"]);
  assert.deepEqual(canonicalLayerNames(null), []);
});

test("um template antigo com duas camadas \"Texto\" fica endereçável sem ser reaberto e salvo", () => {
  const doc = docWith(["Texto", "Texto"]);
  const layers = { texts: { "Texto": "título", "Texto 2": "subtítulo" }, images: {}, hidden: new Set<string>() };
  const rendered = applyLayerOverrides(doc, layers, 1) as typeof doc;
  assert.deepEqual(rendered.pages[0].els.map((e) => [e.name, e.text]), [["Texto", "título"], ["Texto 2", "subtítulo"]]);
});

test("mandar só o nome original atinge a primeira camada, não as duas", () => {
  const doc = docWith(["Texto", "Texto"]);
  const layers = { texts: { "Texto": "só o primeiro" }, images: {}, hidden: new Set<string>() };
  const rendered = applyLayerOverrides(doc, layers, 1) as typeof doc;
  assert.deepEqual(rendered.pages[0].els.map((e) => e.text), ["só o primeiro", ""]);
});
