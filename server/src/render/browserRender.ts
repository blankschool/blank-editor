import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { buildTemplateSvg, pageForRender, type EditableElement, type TemplateOverrides } from "./editableTweetTemplate.ts";
import { editorTextHtml, fitTextElements } from "./editorText.ts";
import { escapeXml } from "./svg.ts";
import type { FaceRef } from "./fontCache.ts";
import { fetchImage } from "./imageSource.ts";

// Bound browser memory under simultaneous API/cover requests.
let active = 0;
const waiting: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve));
  else active++;
}
function release(): void {
  const next = waiting.shift();
  if (next) next(); else active--;
}

export async function renderBrowserPng(
  document: unknown, overrides: TemplateOverrides, images: Record<string, string>,
  faces: readonly FaceRef[], fontFiles: string[], pageIndex?: number,
): Promise<Buffer> {
  const page = pageForRender(document, pageIndex);
  if (!page) throw new Error("template must contain a page");
  const heights = new Map<string, number>();
  const textLayout = {
    render(element: EditableElement, value: string): string {
      // Identical values sent by Playground keep the editor's rich runs.
      const e = value === element.text ? element : { ...element, text: value, runs: undefined, autoFit: true };
      const x = Number(e.x) || 0, y = Number(e.y) || 0;
      const w = Math.max(1, Number(e.w) || 1), h = Math.max(1, Number(e.h) || 1);
      const rot = Number(e.rot) || 0;
      const transform = rot ? ` transform="rotate(${rot} ${x + w / 2} ${y + h / 2})"` : "";
      return `<foreignObject x="${x}" y="${y}" width="${w}" height="${h}" overflow="visible" opacity="${Math.max(0, Math.min(1, e.opacity ?? 1))}"${transform}><div xmlns="http://www.w3.org/1999/xhtml" data-layer="${escapeXml(e.id || e.name || "")}">${editorTextHtml(e)}</div></foreignObject>`;
    },
    height(e: EditableElement): number {
      return heights.get(e.id || e.name || "") ?? Math.max(0, Number(e.h) || 0);
    },
  };
  // Validate bounds and element count before allocating a browser.
  const svg = buildTemplateSvg(document, overrides, images, pageIndex, textLayout);
  const fontCss = (await Promise.all(faces.map(async (face, i) => {
    const bytes = face.browserSrc ? await fetchImage(face.browserSrc) : await readFile(fontFiles[i]);
    const family = JSON.stringify(face.family).replace(/</g, "\\3c ");
    const format = bytes.subarray(0, 4).toString() === "wOF2" ? "woff2" : "truetype";
    return `@font-face{font-family:${family};font-weight:${face.weight};font-style:${face.style || "normal"};src:url(data:font/${format};base64,${bytes.toString("base64")}) format('${format}');}`;
  }))).join("");
  await acquire();
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: page.w!, height: page.h! }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: "block" });
      await context.route("**/*", route => route.abort());
      const tab = await context.newPage();
      tab.setDefaultTimeout(30_000);
      await tab.setContent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:"><style>html,body{margin:0;padding:0}body{overflow:hidden}svg{display:block}*{box-sizing:border-box}${fontCss}</style>${svg}`);
      await tab.evaluate(async () => {
        const doc = (globalThis as any).document;
        await Promise.all(Array.from(doc.fonts as Iterable<any>, f => f.load()));
        await doc.fonts.ready;
      });
      await tab.evaluate(`(${fitTextElements.toString()})()`);
      if (page.els?.some(e => e.centerGroup)) {
        const measured: Array<[string, number]> = await tab.evaluate(() => {
          const doc = (globalThis as any).document;
          return Array.from(doc.querySelectorAll("[data-layer]") as Iterable<any>, e => [e.dataset.layer, e.firstElementChild.offsetHeight]);
        });
        for (const [id, h] of measured) heights.set(id, h);
        const adjusted = buildTemplateSvg(document, overrides, images, pageIndex, textLayout);
        await tab.evaluate(svg => { (globalThis as any).document.querySelector("svg").outerHTML = svg; }, adjusted);
        await tab.evaluate(`(${fitTextElements.toString()})()`);
      }
      return await tab.screenshot({ type: "png", animations: "disabled", timeout: 30_000 });
    } finally {
      await browser.close();
    }
  } finally {
    release();
  }
}
