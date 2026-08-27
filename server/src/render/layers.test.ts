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
  assert.equal(input.avatarUrl, "https://example.com/avatar.jpg");
  assert.equal(input.displayName, "Micael Crasto");
  assert.equal(input.handle, "@MicaelCrasto");
  assert.equal(input.tweetText, "hello world");
  assert.equal(input.verified, true); // no verifiedBadge layer at all -> defaults shown
  assert.equal(input.mediaUrl, undefined);
});

test("hides the verified badge when verifiedBadge.hide is true", () => {
  const input = mapLayersToTweetInput({ ...fullLayers, verifiedBadge: { hide: true } });
  assert.equal(input.verified, false);
});

test("keeps the verified badge when verifiedBadge.hide is false", () => {
  const input = mapLayersToTweetInput({ ...fullLayers, verifiedBadge: { hide: false } });
  assert.equal(input.verified, true);
});

test("includes media.image_url as mediaUrl when present and not hidden", () => {
  const input = mapLayersToTweetInput({ ...fullLayers, media: { image_url: "https://example.com/photo.jpg" } });
  assert.equal(input.mediaUrl, "https://example.com/photo.jpg");
});

test("omits mediaUrl when the media layer is hidden, even with an image_url set", () => {
  const input = mapLayersToTweetInput({
    ...fullLayers,
    media: { image_url: "https://example.com/photo.jpg", hide: true },
  });
  assert.equal(input.mediaUrl, undefined);
});

for (const missing of ["avatar", "displayName", "handle", "tweetText"] as const) {
  test(`throws a descriptive error when required layer "${missing}" is missing`, () => {
    const layers = { ...fullLayers };
    delete (layers as Record<string, unknown>)[missing];
    assert.throws(() => mapLayersToTweetInput(layers), new RegExp(missing));
  });
}
