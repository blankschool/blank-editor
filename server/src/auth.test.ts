import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBearerToken, hashApiKey } from "./auth.ts";

test("extractBearerToken pulls the token out of a well-formed header", () => {
  assert.equal(extractBearerToken("Bearer blk_live_abc123"), "blk_live_abc123");
  assert.equal(extractBearerToken("bearer blk_live_abc123"), "blk_live_abc123");
});

test("extractBearerToken returns null for missing or malformed headers", () => {
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken(""), null);
  assert.equal(extractBearerToken("blk_live_abc123"), null);
  assert.equal(extractBearerToken("Basic abc123"), null);
});

test("hashApiKey is deterministic and distinguishes different keys", () => {
  assert.equal(hashApiKey("same-key"), hashApiKey("same-key"));
  assert.notEqual(hashApiKey("key-a"), hashApiKey("key-b"));
});

test("hashApiKey never returns the plaintext key", () => {
  assert.notEqual(hashApiKey("blk_live_abc123"), "blk_live_abc123");
  assert.match(hashApiKey("blk_live_abc123"), /^[0-9a-f]{64}$/);
});
