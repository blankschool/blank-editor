import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { composeTweetPng, renderTweetPng } from "./renderTweet.ts";

async function solidPng(r: number, g: number, b: number, size = 8): Promise<Buffer> {
  return sharp({ create: { width: size, height: size, channels: 4, background: { r, g, b, alpha: 1 } } })
    .png()
    .toBuffer();
}

test("composes a PNG containing the minimal tweet card", async () => {
  const avatar = await solidPng(200, 30, 30);
  const buf = await composeTweetPng({
    displayName: "Micael Crasto",
    handle: "@MicaelCrasto",
    tweetText: "hello world",
    avatarBuffer: avatar,
  });
  const meta = await sharp(buf).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, 566);
  assert.ok(meta.height && meta.height < 200);
});

test("the composited PNG is fully opaque where the avatar circle sits (no transparency leaking through)", async () => {
  const avatar = await solidPng(200, 30, 30);
  const buf = await composeTweetPng({
    displayName: "x",
    handle: "@x",
    tweetText: "hi",
    avatarBuffer: avatar,
  });
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // Center of the avatar circle: box is (16,16,40,40) -> center (36, 36).
  const idx = (36 * info.width + 36) * info.channels;
  assert.equal(data[idx + 3], 255); // alpha channel fully opaque
});

test("renderTweetPng rejects a private-network avatar URL instead of silently fetching it", async () => {
  await assert.rejects(() =>
    renderTweetPng({
      displayName: "x",
      handle: "@x",
      tweetText: "hi",
      avatarUrl: "http://127.0.0.1:1/x.png",
    }),
  );
});
