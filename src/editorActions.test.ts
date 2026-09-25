import { test } from "node:test";
import assert from "node:assert/strict";
import { copyStyle, distribute, pasteStyle, toggleBullets } from "./editorActions.ts";

test("distribuir deixa os vãos iguais, pontas fixas", () => {
  const els = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 15, y: 0, w: 10, h: 10 }, { x: 90, y: 0, w: 10, h: 10 }];
  distribute(els, "h");
  assert.deepEqual(els.map((e) => e.x), [0, 45, 90]);
});

test("marcadores ligam e desligam em todas as linhas", () => {
  const on = toggleBullets("um\ndois");
  assert.equal(on.text, "• um\n• dois");
  assert.equal(toggleBullets(on.text).text, "um\ndois");
});

test("marcadores preservam trechos de estilo", () => {
  const r = toggleBullets("ab\ncd", [{ text: "a" }, { text: "b\nc", weight: 700 }, { text: "d" }]);
  assert.equal(r.text, "• ab\n• cd");
  assert.deepEqual(r.runs, [{ text: "• a" }, { text: "b\n• c", weight: 700 }, { text: "d" }]);
});

test("copiar/colar estilo só entre tipos compatíveis", () => {
  const src = { type: "text", font: "Inter", size: 40, weight: 700, fill: "#f00" } as any;
  const dst = { type: "text", font: "Arial", size: 10, runs: [{ text: "x", weight: 400 }] } as any;
  assert.equal(pasteStyle(dst, copyStyle(src)), true);
  assert.equal(dst.size, 40);
  assert.equal(dst.runs, undefined);
  assert.equal(pasteStyle({ type: "rect" } as any, copyStyle(src)), false);
});
