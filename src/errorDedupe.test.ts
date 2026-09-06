import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldLogError } from "./console/errorDedupe.ts";

test("allows the first occurrence of a key", () => {
  assert.equal(shouldLogError(`k-${Math.random()}`, 1000), true);
});

test("dedupes repeats within the TTL window", () => {
  const key = `k-${Math.random()}`;
  assert.equal(shouldLogError(key, 1000), true);
  assert.equal(shouldLogError(key, 1500), false);
  assert.equal(shouldLogError(key, 29999), false);
});

test("allows again after the TTL expires", () => {
  const key = `k-${Math.random()}`;
  assert.equal(shouldLogError(key, 1000), true);
  assert.equal(shouldLogError(key, 31001), true);
});

test("independent keys don't interfere with each other", () => {
  const a = `a-${Math.random()}`;
  const b = `b-${Math.random()}`;
  assert.equal(shouldLogError(a, 1000), true);
  assert.equal(shouldLogError(b, 1000), true);
  assert.equal(shouldLogError(a, 1500), false);
  assert.equal(shouldLogError(b, 1500), false);
});
