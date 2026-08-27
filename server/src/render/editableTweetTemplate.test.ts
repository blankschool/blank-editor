import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEditableTweetSvg } from "./editableTweetTemplate.ts";

const document = {
  active: 0,
  pages: [{
    w: 320,
    h: 140,
    bg: "#112233",
    els: [
      {
        id: "avatar",
        type: "image",
        name: "avatar",
        x: 12,
        y: 14,
        w: 44,
        h: 44,
        rot: 0,
        opacity: 1,
        hidden: false,
        radius: 22,
      },
      {
        id: "name",
        type: "text",
        name: "displayName",
        x: 91,
        y: 18,
        w: 210,
        h: 24,
        rot: 0,
        opacity: 1,
        hidden: false,
        fill: "#abcdef",
        text: "valor do editor",
        font: "Inter",
        size: 17,
        weight: 700,
        align: "left",
        lh: 1.2,
        ls: 0,
      },
    ],
  }],
};

test("renders dynamic values using the positions and styles saved by the editor", () => {
  const svg = buildEditableTweetSvg(
    document,
    { displayName: "Nome da API", handle: "@api", tweetText: "texto" },
    "data:image/png;base64,AAAA",
  );

  assert.match(svg, /width="320" height="140"/);
  assert.match(svg, /fill="#112233"/);
  assert.match(svg, /x="91" y="18"/);
  assert.match(svg, /font-size="17"/);
  assert.match(svg, /fill="#abcdef"/);
  assert.match(svg, />Nome da API</);
  assert.doesNotMatch(svg, /valor do editor/);
  assert.match(svg, /data:image\/png;base64,AAAA/);
});
