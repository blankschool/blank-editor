import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLayersToTweetInput } from "./layers.ts";

const fullLayers = {
  avatar: { image_url: "https://example.com/avatar.jpg" },
  displayName: { text: "Micael Crasto" },
  handle: { text: "@MicaelCrasto" },
  tweetText: { text: "hello world" },
};

test("maps a full set of layers into a RenderTweetInput", () => {
  const input = mapLayersToTweetInput(fullLayers);
  assert.deepEqual(input, {
    avatarUrl: "https://example.com/avatar.jpg",
    displayName: "Micael Crasto",
    handle: "@MicaelCrasto",
    tweetText: "hello world",
  });
});

test("ignores unsupported badge and attached-media layers", () => {
  const input = mapLayersToTweetInput({
    ...fullLayers,
    verifiedBadge: { hide: false },
    media: { image_url: "https://example.com/photo.jpg" },
  });
  assert.deepEqual(input, mapLayersToTweetInput(fullLayers));
});

for (const missing of ["avatar", "displayName", "handle", "tweetText"] as const) {
  test(`throws a descriptive error when required layer "${missing}" is missing`, () => {
    const layers = { ...fullLayers };
    delete (layers as Record<string, unknown>)[missing];
    assert.throws(() => mapLayersToTweetInput(layers), new RegExp(missing));
  });
}
