import { test } from "node:test";
import assert from "node:assert/strict";
import { isFlattenedPage } from "./flatDetection.ts";

const canvas = { w: 1080, h: 1350 };

test("página com texto nunca é achatada, mesmo com uma imagem de página inteira", () => {
  const elements = [
    { type: "image" as const, w: 1080, h: 1350 },
    { type: "text" as const, w: 400, h: 60 },
  ];
  assert.equal(isFlattenedPage(elements, canvas), false);
});

test("uma imagem cobrindo a página inteira, sem texto, é achatada", () => {
  const elements = [{ type: "image" as const, w: 1080, h: 1350 }];
  assert.equal(isFlattenedPage(elements, canvas), true);
});

test("tolera uma margem pequena de exportação (90% de cobertura)", () => {
  const elements = [{ type: "image" as const, w: 1000, h: 1250 }];
  assert.equal(isFlattenedPage(elements, canvas), true);
});

test("várias imagens pequenas não contam como achatada", () => {
  const elements = [
    { type: "image" as const, w: 200, h: 200 },
    { type: "image" as const, w: 300, h: 300 },
  ];
  assert.equal(isFlattenedPage(elements, canvas), false);
});

test("página sem elemento nenhum não é achatada — é vazia, caso diferente", () => {
  assert.equal(isFlattenedPage([], canvas), false);
});

test("uma imagem pequena, sozinha, não é achatada — não cobre a página", () => {
  const elements = [{ type: "image" as const, w: 300, h: 300 }];
  assert.equal(isFlattenedPage(elements, canvas), false);
});
