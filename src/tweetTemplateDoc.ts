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

/** The starting point for the "Tweet Hollywood creators" template — used until the server's own copy loads, or if it's unreachable. */
export function createTweetTemplateDocument(): Doc {
  return {
    name: "Tweet Hollywood creators",
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
          y: 64,
          w: 96,
          h: 96,
          radius: 48,
          src: "",
        }),
        element("text", "displayName", {
          x: 188,
          y: 66,
          w: 820,
          h: 40,
          text: "Micael Crasto",
          font: "Inter",
          size: 34,
          weight: 700,
          align: "left",
          lh: 1.25,
          ls: 0,
        }),
        element("text", "handle", {
          x: 188,
          y: 110,
          w: 820,
          h: 34,
          text: "@MicaelCrasto",
          font: "Inter",
          size: 28,
          weight: 400,
          align: "left",
          lh: 1.25,
          ls: 0,
          fill: "#71757A",
        }),
        element("text", "tweetText", {
          x: 72,
          y: 192,
          w: 936,
          h: 290,
          text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n\nUt enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
          font: "Inter",
          size: 34,
          weight: 400,
          align: "left",
          lh: 1.4,
          ls: 0,
        }),
        element("image", "media", {
          x: 72,
          y: 506,
          w: 936,
          h: 620,
          radius: 24,
          src: "",
        }),
      ],
    }],
  };
}

/** Local-only fallback (no network) — the editor's normal open path fetches from the server first. */
export function loadTweetTemplateDocument(): Doc {
  return loadTemplateLocally(TWEET_TEMPLATE_ID) ?? createTweetTemplateDocument();
}
