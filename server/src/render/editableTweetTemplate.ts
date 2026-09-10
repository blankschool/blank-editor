import { escapeXml } from "./svg.ts";
import { wrapText } from "./wrapText.ts";

export interface EditableElement {
  id?: string;
  type?: string;
  name?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rot?: number;
  opacity?: number;
  hidden?: boolean;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  text?: string;
  autoFit?: boolean;
  font?: string;
  size?: number;
  weight?: number;
  italic?: boolean;
  underline?: boolean;
  align?: string;
  /** Elements sharing the same centerGroup move together as one block, vertically centered in the page (equal top/bottom margin) — relative spacing between them (as authored) is preserved. */
  centerGroup?: string;
  lh?: number;
  ls?: number;
  src?: string;
  runs?: Array<import("./editorText.ts").TextStyle & { text: string }>;
}

interface EditablePage {
  w?: number;
  h?: number;
  bg?: string;
  els?: EditableElement[];
}

export interface EditableTemplateDocument {
  active?: number;
  pages?: EditablePage[];
}

export interface TemplateOverrides {
  /** layer name -> replacement text, for elements not covered here the document's own saved text is used. */
  texts: Record<string, string>;
  /** layer names to omit from the render entirely, regardless of what the document says. */
  hidden: Set<string>;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedDimension(value: unknown, name: string): number {
  const result = finite(value);
  if (result <= 0 || result > 4000) throw new Error(`invalid template ${name}`);
  return result;
}

function transform(element: EditableElement): string {
  const rotation = finite(element.rot);
  if (!rotation) return "";
  const cx = finite(element.x) + finite(element.w) / 2;
  const cy = finite(element.y) + finite(element.h) / 2;
  return ` transform="rotate(${rotation} ${cx} ${cy})"`;
}

function paint(element: EditableElement): string {
  const fill = escapeXml(element.fill || "transparent");
  const stroke = element.stroke ? ` stroke="${escapeXml(element.stroke)}" stroke-width="${finite(element.strokeWidth)}"` : "";
  return ` fill="${fill}"${stroke} opacity="${Math.max(0, Math.min(1, finite(element.opacity, 1)))}"`;
}

/** Família usada quando o elemento não declara nenhuma. Exportada porque o resolvedor de
 *  fontes (resolveFonts.ts) precisa exigir exatamente a mesma que o SVG vai pedir. */
export const DEFAULT_FONT_FAMILY = "Inter";

function renderText(element: EditableElement, value: string): string {
  const x = finite(element.x);
  const y = finite(element.y);
  const width = Math.max(1, finite(element.w, 1));
  const size = Math.max(1, finite(element.size, 15));
  const lineHeight = size * Math.max(0.5, finite(element.lh, 1.2));
  const align = element.align === "center" ? "middle" : element.align === "right" ? "end" : "start";
  const anchorX = align === "middle" ? x + width / 2 : align === "end" ? x + width : x;
  const lines = wrapText(value, width, size, element.font);
  const tspans = lines
    .map((line, index) => `<tspan x="${anchorX}" y="${y + index * lineHeight}">${escapeXml(line || " ")}</tspan>`)
    .join("");
  const decoration = element.underline ? ` text-decoration="underline"` : "";
  const style = element.italic ? "italic" : "normal";
  return `<text x="${x}" y="${y}" text-anchor="${align}" dominant-baseline="text-before-edge" font-family="${escapeXml(element.font || DEFAULT_FONT_FAMILY)}" font-size="${size}" font-weight="${finite(element.weight, 400)}" font-style="${style}" letter-spacing="${finite(element.ls)}"${decoration}${paint(element)}${transform(element)}>${tspans}</text>`;
}

/** How tall an element actually renders — real wrapped-line height for text, the authored box otherwise. */
function naturalElementHeight(element: EditableElement, textValue?: string): number {
  if (element.type === "text") {
    const width = Math.max(1, finite(element.w, 1));
    const size = Math.max(1, finite(element.size, 15));
    const lineHeight = size * Math.max(0.5, finite(element.lh, 1.2));
    const lines = wrapText(textValue ?? "", width, size, element.font);
    return lines.length * lineHeight;
  }
  return Math.max(0, finite(element.h));
}

/**
 * For every `centerGroup` present on the page, computes one vertical shift shared by all its
 * members: the group's natural bounding box (from each element's authored `y` to `y + natural
 * height`) is centered in the page, giving it an equal top and bottom margin. Members keep their
 * spacing relative to each other exactly as authored — only the whole block moves. A group taller
 * than the page is pinned to the top (margin 0) rather than pushed above y=0.
 */
function computeGroupShifts(
  els: EditableElement[],
  overrides: TemplateOverrides,
  pageHeight: number,
  measureHeight = naturalElementHeight,
): Map<string, number> {
  const groups = new Map<string, EditableElement[]>();
  for (const element of els) {
    if (!element || element.hidden || !element.centerGroup) continue;
    if (overrides.hidden.has(element.name || "")) continue;
    const list = groups.get(element.centerGroup) ?? [];
    list.push(element);
    groups.set(element.centerGroup, list);
  }

  const shifts = new Map<string, number>();
  for (const [groupId, members] of groups) {
    let top = Infinity;
    let bottom = -Infinity;
    for (const element of members) {
      const textValue = element.type === "text" ? overrides.texts[element.name || ""] ?? String(element.text || "") : undefined;
      const y0 = finite(element.y);
      const y1 = y0 + measureHeight(element, textValue);
      top = Math.min(top, y0);
      bottom = Math.max(bottom, y1);
    }
    if (!Number.isFinite(top)) continue;
    const desiredTop = Math.max(0, (pageHeight - (bottom - top)) / 2);
    shifts.set(groupId, desiredTop - top);
  }
  return shifts;
}

/**
 * A página a renderizar: `pageIndex` quando o chamador pediu uma explicitamente,
 * senão a `active` que o documento guardou.
 *
 * O override existe por causa do carrossel. Sem ele um template de várias páginas
 * só renderiza a capa pela API — o documento tem 3 slides e a chamada devolve
 * sempre o mesmo. Índice base 0 aqui dentro; a API expõe base 1, que é como se
 * fala de "página 2" fora do código.
 */
/** O índice de página resolvido — usado tanto pra renderizar quanto (applyLayerOverrides.ts) pra
 *  saber qual página de fato foi tocada, sem duplicar a mesma conta de clamping em dois lugares. */
export function resolvePageIndex(document: unknown, pageIndex?: number): number | null {
  const candidate = document as EditableTemplateDocument;
  if (!Array.isArray(candidate?.pages) || candidate.pages.length === 0) return null;
  const requested = pageIndex ?? finite(candidate.active);
  return Math.max(0, Math.min(candidate.pages.length - 1, Math.trunc(finite(requested))));
}

function pageAt(document: unknown, pageIndex?: number): EditablePage | null {
  const candidate = document as EditableTemplateDocument;
  const index = resolvePageIndex(document, pageIndex);
  return index === null ? null : candidate.pages![index];
}

/** Quantas páginas o documento tem — o app usa para recusar uma página fora do intervalo com mensagem útil. */
export function pageCount(document: unknown): number {
  const candidate = document as EditableTemplateDocument;
  return Array.isArray(candidate?.pages) ? candidate.pages.length : 0;
}

/**
 * Uma imagem pode guardar o conteúdo em `Doc.assets` e apontar com "@chave" em vez de trazer o
 * `src` inteiro — é como o editor evita duplicar a mesma foto usada em várias páginas
 * (`rawSrcOf`, editor.ts). Quem lê `src` sem resolver isso enxerga a string "@fundo", que não
 * é URL nem data URI: o layer some do render em silêncio. Era o que fazia um design salvo com
 * assets abrir no canvas e renderizar em branco pela API.
 */
function resolveSrc(document: unknown, src: string | undefined): string | undefined {
  if (!src || src[0] !== "@") return src;
  const assets = (document as { assets?: Record<string, string> } | null)?.assets;
  return assets?.[src.slice(1)];
}

/** Every image-type layer a template declares, with whatever `src` it was saved with (if any). */
export function listImageLayers(document: unknown, pageIndex?: number): Array<{ name: string; src?: string }> {
  const page = pageAt(document, pageIndex);
  if (!Array.isArray(page?.els)) return [];
  return page.els
    .filter((el): el is EditableElement & { name: string } => Boolean(el && el.type === "image" && el.name))
    .map((el) => ({ name: el.name, src: resolveSrc(document, el.src) }));
}

/** As faces que este documento carrega consigo — ver Doc.fonts em src/types.ts. Uma entrada sem
 *  `sha256` é descartada: sem identidade não há cache confiável nem detecção de ambiguidade. */
export function listDesignFonts(document: unknown): Array<{ family: string; weight: number; sha256: string; src: string; browserSrc?: string; glyphs?: string }> {
  const fonts = (document as { fonts?: unknown } | null)?.fonts;
  if (!Array.isArray(fonts)) return [];
  return fonts
    .filter((f): f is { family: string; weight: number; sha256: string; ttf: string; woff2?: string; glyphs?: string } =>
      Boolean(f && typeof f.family === "string" && typeof f.ttf === "string" && typeof f.sha256 === "string" && f.sha256))
    .map((f) => ({ family: f.family, weight: Number(f.weight) || 400, sha256: f.sha256, src: f.ttf,
                   ...(f.woff2 ? { browserSrc: f.woff2 } : {}),
                   ...(typeof (f as { glyphs?: unknown }).glyphs === "string" ? { glyphs: (f as { glyphs: string }).glyphs } : {}) }));
}

/** A página que uma renderização vai desenhar — exposta para resolver as fontes DELA, não as da
 *  capa, num documento de várias páginas. */
export function pageForRender(document: unknown, pageIndex?: number) {
  return pageAt(document, pageIndex);
}

/**
 * Renders a template's saved page (the editor's own Doc/Page/El model) to SVG, substituting
 * `overrides.texts`/`overrides.hidden` and `resolvedImages` by element `name` — anything not
 * overridden falls back to whatever the editor saved for that element. This is deliberately
 * generic across whatever a template declares: there's no fixed set of "the tweet's fields",
 * a template's own named elements ARE its API surface.
 */
export function buildTemplateSvg(
  document: unknown,
  overrides: TemplateOverrides,
  resolvedImages: Record<string, string>,
  pageIndex?: number,
  textLayout?: {
    render: (element: EditableElement, value: string) => string;
    height?: (element: EditableElement, value?: string) => number;
  },
): string {
  const page = pageAt(document, pageIndex);
  if (!page) throw new Error("template must contain a page");
  const width = boundedDimension(page.w, "width");
  const height = boundedDimension(page.h, "height");
  if (!Array.isArray(page.els) || page.els.length > 200) throw new Error("invalid template elements");

  const groupShifts = computeGroupShifts(page.els, overrides, height, textLayout?.height);

  const definitions: string[] = [];
  const content: string[] = [];
  page.els.forEach((rawElement, index) => {
    if (!rawElement || rawElement.hidden) return;
    const name = rawElement.name || "";
    if (overrides.hidden.has(name)) return;

    const dy = rawElement.centerGroup ? groupShifts.get(rawElement.centerGroup) ?? 0 : 0;
    const element = dy ? { ...rawElement, y: finite(rawElement.y) + dy } : rawElement;

    const x = finite(element.x);
    const y = finite(element.y);
    const w = Math.max(0, finite(element.w));
    const h = Math.max(0, finite(element.h));
    const radius = Math.max(0, finite(element.radius));

    if (element.type === "text") {
      content.push((textLayout?.render ?? renderText)(element, overrides.texts[name] ?? String(element.text || "")));
      return;
    }
    if (element.type === "image") {
      const source = resolvedImages[name] ?? String(resolveSrc(document, element.src) || "");
      if (!source.startsWith("data:image/")) return;
      const clipId = `image-clip-${index}`;
      definitions.push(`<clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}"/></clipPath>`);
      content.push(`<image href="${escapeXml(source)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})" opacity="${Math.max(0, Math.min(1, finite(element.opacity, 1)))}"${transform(element)}/>`);
      return;
    }
    if (element.type === "ellipse") {
      content.push(`<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"${paint(element)}${transform(element)}/>`);
      return;
    }
    if (element.type === "rect" || element.type === "line") {
      content.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${element.type === "line" ? h / 2 : radius}"${paint(element)}${transform(element)}/>`);
    }
  });

  const defs = definitions.length ? `<defs>${definitions.join("")}</defs>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${escapeXml(page.bg || "#000000")}"/>${defs}${content.join("")}</svg>`;
}
