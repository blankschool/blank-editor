import { test } from "node:test";
import assert from "node:assert/strict";
import { createTweetTemplateDocument } from "./tweetTemplateDoc.ts";

test("creates an editable Twitter document with exactly the five dynamic fields", () => {
  const doc = createTweetTemplateDocument();
  assert.equal(doc.seedId, "tweet-screenshot");
  assert.equal(doc.pages.length, 1);
  assert.deepEqual(
    doc.pages[0].els.map((element) => element.name),
    ["avatar", "displayName", "handle", "tweetText", "media"],
  );
  assert.deepEqual(
    doc.pages[0].els.map((element) => element.type),
    ["image", "text", "text", "text", "image"],
  );
});
