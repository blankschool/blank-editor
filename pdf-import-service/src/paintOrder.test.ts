import { test } from "node:test";
import assert from "node:assert/strict";
import { assignImageZ, sortByPaintOrder } from "./paintOrder.ts";

test("imagem herda o z da imagem do PDF com mais sobreposição", () => {
  const z = assignImageZ(
    [{ x: 0, y: 0, w: 200, h: 200 }, { x: 500, y: 500, w: 100, h: 100 }],
    [{ bbox: [250, 250, 300, 300], z: 9 }, { bbox: [0, 0, 100, 100], z: 2 }],
    2,
  );
  assert.deepEqual(z, [2, 9]);
});

test("imagem sem correspondência fica sem z", () => {
  assert.deepEqual(assignImageZ([{ x: 0, y: 0, w: 10, h: 10 }], [{ bbox: [400, 400, 500, 500], z: 1 }], 1), [null]);
});

test("mesma foto repetida usa cada ordem uma vez", () => {
  const box = { x: 0, y: 0, w: 10, h: 10 };
  assert.deepEqual(assignImageZ([box, box], [{ bbox: [0, 0, 10, 10], z: 7 }, { bbox: [0, 0, 10, 10], z: 3 }], 1), [3, 7]);
});

test("ordena por z real, texto atrás de imagem fica atrás", () => {
  const els = [
    { id: "texto", z: 5 },
    { id: "foto", z: 8 },
    { id: "forma", z: 1 },
    { id: "sem-z", z: null },
  ];
  assert.deepEqual(sortByPaintOrder(els).map((e) => e.id), ["sem-z", "forma", "texto", "foto"]);
});
