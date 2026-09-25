import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStyleToRange, rangeEvery, runsFromPieces } from "./richText.ts";

const bold = (s: { weight?: number }) => (s.weight ?? 400) >= 600;

test("rangeEvery: trecho todo em negrito", () => {
  const runs = applyStyleToRange("Olá mundo", undefined, 4, 9, { weight: 700 });
  assert.equal(rangeEvery("Olá mundo", runs, 4, 9, { weight: 400 }, bold), true);
  assert.equal(rangeEvery("Olá mundo", runs, 2, 9, { weight: 400 }, bold), false);
});

test("rangeEvery: base do elemento em negrito conta", () => {
  assert.equal(rangeEvery("abc", undefined, 0, 2, { weight: 700 }, bold), true);
});

test("runsFromPieces junta pedaços com o mesmo estilo e mantém quebras", () => {
  assert.deepEqual(runsFromPieces([
    { text: "Oi ", style: {} }, { text: "você", style: { weight: 700 } }, { text: "\n", style: { weight: 700 } }, { text: "fim", style: {} },
  ]), [{ text: "Oi " }, { text: "você\n", weight: 700 }, { text: "fim" }]);
});
