import type { Doc, El } from "./types.ts";

export const TWEET_TEMPLATE_ID = "tweet-screenshot";
export const TWEET_TEMPLATE_STORAGE_KEY = "blank-editor-template-tweet-screenshot-v1";

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
          y: 308,
          w: 936,
          h: 902,
          text: "Template local funcionando de verdade.",
          font: "Inter",
          size: 46,
          weight: 400,
          align: "left",
          lh: 1.45,
          ls: 0,
        }),
      ],
    }],
  };
}

function isTweetTemplateDocument(value: unknown): value is Doc {
  const candidate = value as Partial<Doc> | null;
  return candidate?.seedId === TWEET_TEMPLATE_ID && Array.isArray(candidate.pages) && candidate.pages.length > 0;
}

export function loadTweetTemplateDocument(): Doc {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(TWEET_TEMPLATE_STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (isTweetTemplateDocument(saved)) return saved;
      }
    }
  } catch { /* unavailable storage or malformed saved document */ }
  return createTweetTemplateDocument();
}

export function saveTweetTemplateDocument(doc: Doc): void {
  if (!isTweetTemplateDocument(doc)) return;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(TWEET_TEMPLATE_STORAGE_KEY, JSON.stringify(doc));
    }
  } catch { /* quota or blocked storage */ }
}
