import { test } from "node:test";
import assert from "node:assert/strict";
import { cropToBackgroundStyle, cropToSourceRect } from "./imageCrop.ts";

test("no crop fields behaves as a full-image (no-op) window", () => {
  const style = cropToBackgroundStyle({});
  assert.deepEqual(style.sizePct, [100, 100]);
  assert.deepEqual(style.positionPct, [0, 0]);

  const rect = cropToSourceRect({}, 800, 600);
  assert.deepEqual(rect, { sx: 0, sy: 0, sw: 800, sh: 600 });
});

test("a centered half-size crop maps to background-size 200% and position 50%", () => {
  const style = cropToBackgroundStyle({ imgX: 0.25, imgY: 0.25, imgW: 0.5, imgH: 0.5 });
  assert.deepEqual(style.sizePct, [200, 200]);
  assert.deepEqual(style.positionPct, [50, 50]);
});

test("a crop pinned to the top-left corner has position 0%", () => {
  const style = cropToBackgroundStyle({ imgX: 0, imgY: 0, imgW: 0.5, imgH: 0.5 });
  assert.deepEqual(style.positionPct, [0, 0]);
});

test("a crop pinned to the bottom-right corner has position 100%", () => {
  const style = cropToBackgroundStyle({ imgX: 0.5, imgY: 0.5, imgW: 0.5, imgH: 0.5 });
  assert.deepEqual(style.positionPct, [100, 100]);
});

test("out-of-range crop values are clamped so the window never exceeds the source image", () => {
  const style = cropToBackgroundStyle({ imgX: 0.9, imgY: -0.5, imgW: 0.5, imgH: 0.5 });
  // x clamps to 1 - w = 0.5, y clamps to 0
  assert.deepEqual(style.positionPct, [100, 0]);
});

test("cropToSourceRect converts a normalised window into real pixels of the loaded image", () => {
  const rect = cropToSourceRect({ imgX: 0.25, imgY: 0.1, imgW: 0.5, imgH: 0.8 }, 1000, 500);
  assert.deepEqual(rect, { sx: 250, sy: 50, sw: 500, sh: 400 });
});

test("a degenerate zero-size crop is floored to a minimum of 1px, not zero", () => {
  const rect = cropToSourceRect({ imgX: 0, imgY: 0, imgW: 0, imgH: 0 }, 1000, 500);
  assert.equal(rect.sw, 1);
  assert.equal(rect.sh, 1);
});
