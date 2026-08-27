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
      w: 566,
      h: 120,
      bg: "#000000",
      els: [
        element("image", "avatar", {
          x: 16,
          y: 16,
          w: 40,
          h: 40,
          radius: 20,
          src: "https://github.com/github.png",
        }),
        element("text", "displayName", {
          x: 64,
          y: 16,
          w: 486,
          h: 20,
          text: "Micael Crasto",
          font: "Inter",
          size: 15,
          weight: 700,
          align: "left",
          lh: 1.3,
          ls: 0,
        }),
        element("text", "handle", {
          x: 64,
          y: 36,
          w: 486,
          h: 20,
          text: "@MicaelCrasto",
          font: "Inter",
          size: 15,
          weight: 400,
          align: "left",
          lh: 1.3,
          ls: 0,
          fill: "#71757A",
        }),
        element("text", "tweetText", {
          x: 16,
          y: 68,
          w: 534,
          h: 36,
          text: "Template local funcionando de verdade.",
          font: "Inter",
          size: 15,
          weight: 400,
          align: "left",
          lh: 1.33,
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
