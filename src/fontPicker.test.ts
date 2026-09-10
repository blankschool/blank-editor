import { test } from "node:test";
import assert from "node:assert/strict";
import { fontOptions, FONTS } from "./fontPicker.ts";

test("a built-in family selects its own option without lengthening the list", () => {
  const options = fontOptions("Montserrat");
  assert.equal(options.length, FONTS.length);
  assert.deepEqual(options.filter((o) => o.selected), [{ value: "Montserrat", label: "Montserrat", selected: true }]);
});

test("a family resolved at import is listed so the picker names what the canvas draws", () => {
  const options = fontOptions("Libre Caslon Condensed");
  assert.deepEqual(options[0], { value: "Libre Caslon Condensed", label: "Libre Caslon Condensed", selected: true });
  assert.equal(options.filter((o) => o.selected).length, 1);
});

test("a replacement face is offered under its bare family name, keeping the prefixed value", () => {
  const options = fontOptions("Blank Complete Libre Caslon Condensed");
  assert.deepEqual(options[0], { value: "Blank Complete Libre Caslon Condensed", label: "Libre Caslon Condensed", selected: true });
});

test("a text element with no family yet leaves every option unselected", () => {
  const options = fontOptions(undefined);
  assert.equal(options.length, FONTS.length);
  assert.equal(options.filter((o) => o.selected).length, 0);
});
