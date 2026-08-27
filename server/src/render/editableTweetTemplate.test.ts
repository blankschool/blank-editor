import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTemplateSvg } from "./editableTweetTemplate.ts";

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
      {
        id: "badge",
        type: "text",
        name: "verifiedBadge",
        x: 250,
        y: 18,
        w: 40,
        h: 24,
        rot: 0,
        opacity: 1,
        hidden: false,
        fill: "#1D9BF0",
        text: "✓",
        font: "Inter",
        size: 15,
        weight: 400,
        align: "left",
        lh: 1.2,
        ls: 0,
      },
    ],
  }],
};

const noOverrides = { texts: {}, hidden: new Set<string>() };

test("uses the editor's saved position/style, falling back to its saved text when no override is given", () => {
  const svg = buildTemplateSvg(document, noOverrides, {});
  assert.match(svg, /width="320" height="140"/);
  assert.match(svg, /fill="#112233"/);
  assert.match(svg, /x="91" y="18"/);
  assert.match(svg, /font-size="17"/);
  assert.match(svg, /fill="#abcdef"/);
  assert.match(svg, />valor do editor</);
});

test("overrides a named text layer's content by name", () => {
  const svg = buildTemplateSvg(document, { texts: { displayName: "Nome da API" }, hidden: new Set() }, {});
  assert.match(svg, />Nome da API</);
  assert.doesNotMatch(svg, /valor do editor/);
});

test("embeds a fetched image for any named image layer, not just 'avatar'", () => {
  const svg = buildTemplateSvg(document, noOverrides, { avatar: "data:image/png;base64,AAAA" });
  assert.match(svg, /data:image\/png;base64,AAAA/);
});

test("omits a layer entirely when its name is in `hidden`", () => {
  const svg = buildTemplateSvg(document, { texts: {}, hidden: new Set(["verifiedBadge"]) }, {});
  assert.doesNotMatch(svg, /verifiedBadge|✓/);
});

test("an image element with no fetched data URL and no embedded src is skipped, not broken", () => {
  const svg = buildTemplateSvg(document, noOverrides, {});
  assert.doesNotMatch(svg, /<image/);
});
