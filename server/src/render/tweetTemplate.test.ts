import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTweetSvg, TWEET_WIDTH } from "./tweetTemplate.ts";

const base = {
  displayName: "Micael Crasto",
  handle: "@MicaelCrasto",
  verified: true,
  tweetText: "hello world",
  hasMedia: false,
};

test("renders the display name and handle, escaped", () => {
  const { svg } = buildTweetSvg({ ...base, displayName: "A & B", handle: "@a<b>" });
  assert.match(svg, /A &amp; B/);
  assert.match(svg, /@a&lt;b&gt;/);
  assert.doesNotMatch(svg, /A & B/);
});

test("includes the verified badge only when verified is true", () => {
  const verified = buildTweetSvg({ ...base, verified: true });
  const unverified = buildTweetSvg({ ...base, verified: false });
  assert.match(verified.svg, /verifiedBadge/);
  assert.doesNotMatch(unverified.svg, /verifiedBadge/);
});

test("reports the avatar box at a fixed position", () => {
  const { layout } = buildTweetSvg(base);
  assert.deepEqual(layout.avatarBox, { x: 16, y: 16, size: 40 });
});

test("has no media box when hasMedia is false, and grows height to fit wrapped text", () => {
  const short = buildTweetSvg({ ...base, tweetText: "short" });
  const long = buildTweetSvg({
    ...base,
    tweetText: "a very long tweet ".repeat(20).trim(),
  });
  assert.equal(short.layout.mediaBox, null);
  assert.equal(long.layout.mediaBox, null);
  assert.ok(long.layout.height > short.layout.height);
});

test("reserves a media box below the text when hasMedia is true", () => {
  const { layout } = buildTweetSvg({ ...base, hasMedia: true });
  assert.ok(layout.mediaBox);
  assert.equal(layout.mediaBox!.x, 16);
  assert.equal(layout.mediaBox!.width, TWEET_WIDTH - 32);
  assert.equal(layout.height, layout.mediaBox!.y + layout.mediaBox!.height + 16);
});

test("SVG root declares the full computed width and height", () => {
  const { svg, layout } = buildTweetSvg({ ...base, hasMedia: true });
  assert.match(svg, new RegExp(`width="${layout.width}" height="${layout.height}"`));
});
