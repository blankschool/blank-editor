import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStyleToRange } from "./richText.ts";

test("applying a color to a range of plain text creates exactly 3 runs (before/selected/after)", () => {
  const runs = applyStyleToRange("hello world", undefined, 6, 11, { fill: "#ff0000" });
  assert.deepEqual(runs, [
    { text: "hello " },
    { text: "world", fill: "#ff0000" },
  ]);
});

test("coloring the whole text produces a single run with the override", () => {
  const runs = applyStyleToRange("hello", undefined, 0, 5, { fill: "#00ff00" });
  assert.deepEqual(runs, [{ text: "hello", fill: "#00ff00" }]);
});

test("coloring a middle slice keeps the untouched prefix and suffix as separate runs", () => {
  const runs = applyStyleToRange("abcdefgh", undefined, 2, 5, { fill: "#111111" });
  assert.deepEqual(runs, [
    { text: "ab" },
    { text: "cde", fill: "#111111" },
    { text: "fgh" },
  ]);
});

test("a collapsed or backwards-but-empty range is a no-op, returning the existing runs untouched", () => {
  const existing = [{ text: "hi", fill: "#abc" }];
  assert.deepEqual(applyStyleToRange("hi", existing, 1, 1), existing);
});

test("start/end are accepted in either order (drag-selecting right-to-left)", () => {
  const forward = applyStyleToRange("hello world", undefined, 6, 11, { fill: "#ff0000" });
  const backward = applyStyleToRange("hello world", undefined, 11, 6, { fill: "#ff0000" });
  assert.deepEqual(forward, backward);
});

test("applying a second color inside an already-colored run splits it correctly", () => {
  // "hello WORLD" where WORLD is already red; now recolor just "OR" (chars 7..9) blue.
  const runs = [{ text: "hello ", fill: undefined }, { text: "WORLD", fill: "#ff0000" }].map((r) =>
    r.fill ? r : { text: r.text },
  );
  const result = applyStyleToRange("hello WORLD", runs as any, 7, 9, { fill: "#0000ff" });
  assert.deepEqual(result, [
    { text: "hello " },
    { text: "W", fill: "#ff0000" },
    { text: "OR", fill: "#0000ff" },
    { text: "LD", fill: "#ff0000" },
  ]);
});

test("adjacent segments that end up with the identical resulting style are merged back together", () => {
  // Recoloring the whole already-uniformly-colored text with the SAME color collapses to 1 run.
  const runs = [{ text: "ab", fill: "#111" }, { text: "cd", fill: "#111" }];
  const result = applyStyleToRange("abcd", runs, 0, 4, { fill: "#111" });
  assert.deepEqual(result, [{ text: "abcd", fill: "#111" }]);
});

test("out-of-range offsets are clamped to the text bounds instead of throwing", () => {
  const runs = applyStyleToRange("hi", undefined, -5, 999, { fill: "#fff" });
  assert.deepEqual(runs, [{ text: "hi", fill: "#fff" }]);
});

test("overriding weight/italic alongside fill preserves both in the resulting run", () => {
  const runs = applyStyleToRange("bold word", undefined, 0, 4, { fill: "#000", weight: 700 });
  assert.deepEqual(runs, [
    { text: "bold", fill: "#000", weight: 700 },
    { text: " word" },
  ]);
});
