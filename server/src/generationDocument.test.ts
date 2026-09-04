import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeneratedDocument } from "./generationDocument.ts";

const SOURCE = {
  name: "Modelo",
  active: 0,
  pages: [{
    id: "source-page",
    w: 1080,
    h: 1350,
    bg: "#101218",
    els: [
      { id: "title", type: "text", name: "titulo", text: "Título", hidden: false },
      { id: "body", type: "text", name: "corpo", text: "Corpo", hidden: false },
      { id: "image", type: "image", name: "foto", src: "https://example.test/old.png", hidden: false },
      { id: "decoration", type: "rect", name: "faixa", hidden: false },
    ],
  }],
};

test("a one-page template becomes an editable page for every generated card without changing the source", () => {
  const original = structuredClone(SOURCE);
  const result = buildGeneratedDocument(SOURCE, "Carrossel gerado", [
    { layers: { titulo: { text: "Capa" }, corpo: { text: "Abertura" } } },
    { layers: { titulo: { text: "Conclusão" }, corpo: { text: "Fechamento" }, foto: { image_url: "https://example.test/new.png" } } },
  ]);

  assert.equal(result.name, "Carrossel gerado");
  assert.equal(result.active, 0);
  assert.equal(result.pages.length, 2);
  assert.notEqual(result.pages[0].id, "source-page");
  assert.notEqual(result.pages[0].id, result.pages[1].id);
  assert.equal(result.pages[0].els!.find((el) => el.name === "titulo")?.text, "Capa");
  assert.equal(result.pages[1].els!.find((el) => el.name === "corpo")?.text, "Fechamento");
  assert.equal(result.pages[1].els!.find((el) => el.name === "foto")?.src, "https://example.test/new.png");
  assert.deepEqual(SOURCE, original);
});

test("a multi-page template rejects a generated page count that does not match", () => {
  const source = { ...SOURCE, pages: [SOURCE.pages[0], { ...SOURCE.pages[0], id: "source-page-2" }] };

  assert.throws(
    () => buildGeneratedDocument(source, "Inválido", [{ layers: {} }]),
    /must match the template page count of 2/,
  );
});

test("a generated page rejects a layer name that is not editable in the template", () => {
  assert.throws(
    () => buildGeneratedDocument(SOURCE, "Inválido", [{ layers: { desconhecida: { text: "x" } } }]),
    /page 1 has unknown layer: desconhecida/,
  );
});

test("a generated page rejects values that do not match the template layer type", () => {
  assert.throws(
    () => buildGeneratedDocument(SOURCE, "Inválido", [{ layers: { titulo: { image_url: "https://example.test/a.png" } } }]),
    /page 1 layer titulo does not accept image_url/,
  );
});

test("a generated page rejects invalid scalar values instead of persisting them", () => {
  assert.throws(
    () => buildGeneratedDocument(SOURCE, "Inválido", [{ layers: { titulo: { text: 42 as unknown as string } } }]),
    /titulo\.text must be a string/,
  );
  assert.throws(
    () => buildGeneratedDocument(SOURCE, "Inválido", [{ layers: { faixa: { hide: "yes" as unknown as boolean } } }]),
    /faixa\.hide must be a boolean/,
  );
});

test("visibility overrides are persisted in the generated editable document", () => {
  const result = buildGeneratedDocument(SOURCE, "Sem faixa", [{ layers: { faixa: { hide: true } } }]);

  assert.equal(result.pages[0].els!.find((element) => element.name === "faixa")?.hidden, true);
});

test("a template without pages cannot produce a generated design", () => {
  assert.throws(
    () => buildGeneratedDocument({ name: "Vazio", active: 0, pages: [] }, "Inválido", [{ layers: {} }]),
    /template must contain at least one page/,
  );
});
