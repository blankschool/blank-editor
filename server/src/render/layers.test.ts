import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLayers } from "./layers.ts";

test("splits text and image_url overrides into separate maps, keyed by layer name", () => {
  const parsed = parseLayers({
    displayName: { text: "Nome" },
    handle: { text: "@x" },
    avatar: { image_url: "https://example.com/a.jpg" },
  });
  assert.deepEqual(parsed.texts, { displayName: "Nome", handle: "@x" });
  assert.deepEqual(parsed.images, { avatar: "https://example.com/a.jpg" });
  assert.deepEqual([...parsed.hidden], []);
});

test("collects layer names with hide: true", () => {
  const parsed = parseLayers({
    verifiedBadge: { hide: true },
    media: { image_url: "https://example.com/p.jpg", hide: true },
  });
  assert.deepEqual([...parsed.hidden].sort(), ["media", "verifiedBadge"]);
  // A hidden image layer still reports its image_url — the renderer decides to skip it because
  // it's hidden, not because the override silently vanished.
  assert.deepEqual(parsed.images, { media: "https://example.com/p.jpg" });
});

test("ignores an explicit hide: false", () => {
  const parsed = parseLayers({ verifiedBadge: { hide: false } });
  assert.deepEqual([...parsed.hidden], []);
});

test("returns empty maps for an empty layers object", () => {
  const parsed = parseLayers({});
  assert.deepEqual(parsed.texts, {});
  assert.deepEqual(parsed.images, {});
  assert.deepEqual([...parsed.hidden], []);
});
