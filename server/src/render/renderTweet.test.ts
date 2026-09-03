import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { renderTemplatePng } from "./renderTweet.ts";
import { FIXTURE_FAMILY, fixtureDocFont } from "./__fixtures__/fixtureFont.ts";

function textOnlyDocument(text: string) {
  return {
    active: 0,
    fonts: [fixtureDocFont()],
    pages: [{
      w: 300,
      h: 100,
      bg: "#000000",
      els: [{ type: "text", name: "tweetText", x: 10, y: 10, w: 280, h: 40, text, size: 15, font: FIXTURE_FAMILY }],
    }],
  };
}

const noLayers = { texts: {}, images: {}, hidden: new Set<string>() };

test("renders a text-only document to a PNG with no network calls needed", async () => {
  const buf = await renderTemplatePng(textOnlyDocument("hello"), noLayers);
  const meta = await sharp(buf).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, 300);
  assert.equal(meta.height, 100);
});

test("an image element whose saved src is already a data URI renders without fetching anything", async () => {
  const tinyPng = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } })
    .png()
    .toBuffer();
  const dataUrl = `data:image/png;base64,${tinyPng.toString("base64")}`;
  const document = {
    active: 0,
    pages: [{
      w: 100,
      h: 100,
      bg: "#000000",
      els: [{ type: "image", name: "avatar", x: 0, y: 0, w: 40, h: 40, src: dataUrl }],
    }],
  };
  const buf = await renderTemplatePng(document, noLayers);
  const meta = await sharp(buf).metadata();
  assert.equal(meta.format, "png");
});

test("rejects a request whose image override points at a private address", async () => {
  const document = {
    active: 0,
    pages: [{ w: 100, h: 100, bg: "#000", els: [{ type: "image", name: "avatar", x: 0, y: 0, w: 40, h: 40 }] }],
  };
  await assert.rejects(() =>
    renderTemplatePng(document, { texts: {}, images: { avatar: "http://127.0.0.1:1/x.png" }, hidden: new Set() }),
  );
});

test("does not fetch an image layer that the request hides", async () => {
  const document = {
    active: 0,
    pages: [{
      w: 100,
      h: 100,
      bg: "#000",
      // A src pointing at a private/unroutable host would make fetchImage throw if it were ever
      // attempted — this documents that a hidden layer's image is never fetched at all.
      els: [{ type: "image", name: "avatar", x: 0, y: 0, w: 40, h: 40, src: "http://127.0.0.1:1/x.png" }],
    }],
  };
  const buf = await renderTemplatePng(document, { texts: {}, images: {}, hidden: new Set(["avatar"]) });
  const meta = await sharp(buf).metadata();
  assert.equal(meta.format, "png");
});
