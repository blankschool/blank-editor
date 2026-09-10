import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapText } from "./wrapText.ts";

test("keeps a short line on its own", () => {
  assert.deepEqual(wrapText("hello world", 500, 15), ["hello world"]);
});

test("wraps a long line without splitting words", () => {
  const lines = wrapText(
    "this is a fairly long sentence that should wrap across more than one line",
    200,
    15,
  );
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(!line.includes("  "));
    for (const word of line.split(" ")) {
      assert.ok(
        "this is a fairly long sentence that should wrap across more than one line".includes(word),
      );
    }
  }
  assert.equal(lines.join(" "), "this is a fairly long sentence that should wrap across more than one line");
});

test("keeps imported condensed headlines on one line when they fit the authored box", () => {
  const lines = wrapText("O Pânico na Band acabou ", 803, 74.98666666666666, "LibreCaslonCondensed");
  assert.deepEqual(lines, ["O Pânico na Band acabou "]);
});

test("treats explicit newlines as paragraph breaks", () => {
  const lines = wrapText("first paragraph\n\nsecond paragraph", 1000, 15);
  assert.deepEqual(lines, ["first paragraph", "", "second paragraph"]);
});

test("breaks a single word longer than the max width", () => {
  const lines = wrapText("supercalifragilisticexpialidocious", 40, 15);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(""), "supercalifragilisticexpialidocious");
});

test("returns a single empty line for empty input", () => {
  assert.deepEqual(wrapText("", 500, 15), [""]);
});
