import { webfonts, type webfonts_v1 } from "@googleapis/webfonts";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { create } from "fontkit";

const require = createRequire(import.meta.url);
export interface CompleteImportFace {
  family: string;
  weight: number;
  style: "normal" | "italic";
  bytes: Buffer;
  ext: "ttf" | "woff2";
  sha256: string;
  source: "fontsource" | "google-fonts";
}
export interface FontRequest { family: string; weight: number; italic: boolean; text: string }
type Catalog = webfonts_v1.Schema$Webfont[];
const canonical = (name: string) => name.replace(/^[A-Z]{6}\+/, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
export function fontFamilyKey(name: string): string {
  return canonical(name).replace(/(?:bolditalic|boldoblique|semibolditalic|semibold|extrabold|bold|regular|italic|oblique|light|medium|black)(?:mt)?$/, "");
}

function covers(bytes: Buffer, text: string): boolean {
  const font = create(bytes);
  return "hasGlyphForCodePoint" in font && [...text].every(c => /\s/.test(c) || font.hasGlyphForCodePoint(c.codePointAt(0)!));
}

export function createImportFontResolver(options: {
  apiKey?: string;
  catalog?: () => Promise<Catalog>;
  download?: (url: string) => Promise<Buffer>;
} = {}) {
  let catalog: Promise<Catalog> | undefined;
  const files = new Map<string, Promise<Buffer>>();
  const getCatalog = () => catalog ??= (options.catalog ? options.catalog() : options.apiKey
    ? webfonts({ version: "v1", auth: options.apiKey }).webfonts.list({}, { timeout: 15000 }).then(r => r.data.items ?? [])
    : Promise.resolve([])).catch(() => { catalog = undefined; return []; });
  const download = options.download ?? (async (url: string) => {
    const parsed = new URL(url);
    if (parsed.hostname !== "fonts.gstatic.com") throw new Error("Invalid Google font host");
    parsed.protocol = "https:";
    const response = await fetch(parsed, { signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!response.ok) throw new Error("Google font download failed");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) throw new Error("Font file too large");
    return bytes;
  });
  function file(key: string, read: () => Promise<Buffer>): Promise<Buffer> {
    let result = files.get(key);
    if (!result) { result = read().catch(error => { files.delete(key); throw error; }); files.set(key, result); }
    return result;
  }
  return async (request: FontRequest): Promise<CompleteImportFace | null> => {
    const name = fontFamilyKey(request.family);
    const style = request.italic ? "italic" : "normal";
    let family: string, bytes: Buffer, ext: "ttf" | "woff2", source: CompleteImportFace["source"];
    try {
      const local = name === "montserrat" ? {
        family: "Montserrat", path: `@fontsource-variable/montserrat/files/montserrat-latin-wght-${style}.woff2`,
        supported: request.weight >= 100 && request.weight <= 900,
      } : name === "librecasloncondensed" ? {
        family: "Libre Caslon Condensed", path: `@fontsource/libre-caslon-condensed/files/libre-caslon-condensed-latin-${request.weight}-${style}.woff2`,
        supported: [400, 500, 600, 700].includes(request.weight),
      } : null;
      if (local?.supported) {
        bytes = await file(local.path, () => readFile(require.resolve(local.path)));
        if (covers(bytes, request.text)) {
          return { family: local.family, weight: request.weight, style, bytes, ext: "woff2", source: "fontsource", sha256: createHash("sha256").update(bytes).digest("hex") };
        }
      }
      const match = (await getCatalog()).find(f => canonical(f.family ?? "") === name);
      const variant = request.italic ? (request.weight === 400 ? "italic" : `${request.weight}italic`) : (request.weight === 400 ? "regular" : String(request.weight));
      const url = match?.files?.[variant];
      if (!url || !match?.family) return null;
      family = match.family;
      bytes = await file(url, () => download(url));
      if (!covers(bytes, request.text)) return null;
      ext = bytes.subarray(0, 4).toString() === "wOF2" ? "woff2" : "ttf";
      source = "google-fonts";
      return { family, weight: request.weight, style, bytes, ext, source, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch { return null; }
  };
}
