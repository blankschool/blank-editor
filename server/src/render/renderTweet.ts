import sharp from "sharp";
import { buildTemplateSvg, listImageLayers, type TemplateOverrides } from "./editableTweetTemplate.ts";
import { fetchImage } from "./imageSource.ts";
import type { ParsedLayers } from "./layers.ts";

async function toDataUrl(url: string): Promise<string> {
  const raw = await fetchImage(url);
  const png = await sharp(raw).png().toBuffer(); // normalize whatever format was fetched to PNG
  return `data:image/png;base64,${png.toString("base64")}`;
}

/**
 * Renders a template document to PNG. Fetches (SSRF-guarded) whatever image layers need it:
 * a request override first, then — for any image layer not overridden or hidden — the URL the
 * template itself was saved with, if that's a plain http(s) URL rather than an embedded data URI.
 */
export async function renderTemplatePng(
  document: unknown,
  layers: ParsedLayers,
  pageIndex?: number,
): Promise<Buffer> {
  const toFetch: Record<string, string> = {};
  for (const [name, url] of Object.entries(layers.images)) {
    if (!layers.hidden.has(name)) toFetch[name] = url;
  }
  // As imagens buscadas têm que ser as DESTA página: um carrossel com foto
  // diferente por slide baixaria a foto errada se olhássemos sempre a capa.
  for (const { name, src } of listImageLayers(document, pageIndex)) {
    if (layers.hidden.has(name) || toFetch[name]) continue;
    if (src && /^https?:\/\//i.test(src)) toFetch[name] = src;
  }

  const fetched = await Promise.all(
    Object.entries(toFetch).map(async ([name, url]) => [name, await toDataUrl(url)] as const),
  );
  const resolvedImages = Object.fromEntries(fetched);

  const overrides: TemplateOverrides = { texts: layers.texts, hidden: layers.hidden };
  const svg = buildTemplateSvg(document, overrides, resolvedImages, pageIndex);
  return sharp(Buffer.from(svg)).png().toBuffer();
}
