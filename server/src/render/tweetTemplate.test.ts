import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTweetSvg } from "./tweetTemplate.ts";

const base = {
  displayName: "Micael Crasto",
  handle: "@MicaelCrasto",
  tweetText: "hello world",
};

test("renders the display name and handle, escaped", () => {
  const { svg } = buildTweetSvg({ ...base, displayName: "A & B", handle: "@a<b>" });
  assert.match(svg, /A &amp; B/);
  assert.match(svg, /@a&lt;b&gt;/);
  assert.doesNotMatch(svg, /A & B/);
});

test("contains only the avatar, name, handle and tweet text layout", () => {
  const { svg, layout } = buildTweetSvg(base);
  assert.doesNotMatch(svg, /verifiedBadge|mediaBox|views|likes|replies|comments|actions/i);
  assert.deepEqual(Object.keys(layout).sort(), ["avatarBox", "height", "width"]);
});

test("reports the avatar box at a fixed position", () => {
  const { layout } = buildTweetSvg(base);
  assert.deepEqual(layout.avatarBox, { x: 16, y: 16, size: 40 });
});

test("grows height to fit wrapped text", () => {
  const short = buildTweetSvg({ ...base, tweetText: "short" });
  const long = buildTweetSvg({
    ...base,
    tweetText: "a very long tweet ".repeat(20).trim(),
  });
  assert.ok(long.layout.height > short.layout.height);
});

test("SVG root declares the full computed width and height", () => {
  const { svg, layout } = buildTweetSvg(base);
  assert.match(svg, new RegExp(`width="${layout.width}" height="${layout.height}"`));
});
