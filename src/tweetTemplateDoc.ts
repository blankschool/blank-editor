import type { Doc, El } from "./types";
import { loadTemplateLocally } from "./templateStore.ts";

export const TWEET_TEMPLATE_ID = "tweet-screenshot";

function element(type: El["type"], name: string, over: Partial<El>): El {
  return {
    id: `${name}-field`,
    type,
    name,
    x: 0,
    y: 0,
    w: 100,
    h: 20,
    rot: 0,
    opacity: 1,
    locked: false,
    hidden: false,
    fill: "#E6E9EA",
    stroke: "",
    strokeWidth: 0,
    radius: 0,
    ...over,
  };
}

/** The starting point for the "Twitter mínimo" template — used until the server's own copy loads, or if it's unreachable. */
export function createTweetTemplateDocument(): Doc {
  return {
    name: "Twitter mínimo",
    seedId: TWEET_TEMPLATE_ID,
    active: 0,
    pages: [{
      id: "tweet-page",
      w: 1080,
      h: 1350,
      bg: "#000000",
      els: [
        element("image", "avatar", {
          x: 72,
          y: 140,
          w: 112,
          h: 112,
          radius: 56,
          src: "https://github.com/github.png",
        }),
        element("text", "displayName", {
          x: 204,
          y: 142,
          w: 804,
          h: 48,
          text: "Micael Crasto",
          font: "Inter",
          size: 40,
          weight: 700,
          align: "left",
          lh: 1.25,
          ls: 0,
        }),
        element("text", "handle", {
          x: 204,
          y: 196,
          w: 804,
          h: 40,
          text: "@MicaelCrasto",
          font: "Inter",
          size: 34,
          weight: 400,
          align: "left",
          lh: 1.25,
          ls: 0,
          fill: "#71757A",
        }),
        element("text", "tweetText", {
          x: 72,
          y: 420,
          w: 936,
          h: 790,
          text: "Template local funcionando de verdade.",
          font: "Inter",
          size: 56,
          weight: 400,
          align: "left",
          lh: 1.4,
          ls: 0,
        }),
      ],
    }],
  };
}

/** Local-only fallback (no network) — the editor's normal open path fetches from the server first. */
export function loadTweetTemplateDocument(): Doc {
  return loadTemplateLocally(TWEET_TEMPLATE_ID) ?? createTweetTemplateDocument();
}
