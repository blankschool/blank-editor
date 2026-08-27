import { escapeXml } from "./svg.ts";
import { wrapText } from "./wrapText.ts";
import type { TweetInput } from "./tweetTemplate.ts";

interface EditableElement {
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
  font?: string;
  size?: number;
  weight?: number;
  italic?: boolean;
  underline?: boolean;
  align?: string;
  lh?: number;
  ls?: number;
  src?: string;
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

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedDimension(value: unknown, name: string): number {
  const result = finite(value);
  if (result <= 0 || result > 4000) throw new Error(`invalid editable template ${name}`);
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

function renderText(element: EditableElement, value: string): string {
  const x = finite(element.x);
  const y = finite(element.y);
  const width = Math.max(1, finite(element.w, 1));
  const size = Math.max(1, finite(element.size, 15));
  const lineHeight = size * Math.max(0.5, finite(element.lh, 1.2));
  const align = element.align === "center" ? "middle" : element.align === "right" ? "end" : "start";
  const anchorX = align === "middle" ? x + width / 2 : align === "end" ? x + width : x;
  const lines = wrapText(value, width, size);
  const tspans = lines.map((line, index) =>
    `<tspan x="${anchorX}" y="${y + index * lineHeight}">${escapeXml(line || " ")}</tspan>`
  ).join("");
  const decoration = element.underline ? " text-decoration=\"underline\"" : "";
  const style = element.italic ? "italic" : "normal";
  return `<text x="${x}" y="${y}" text-anchor="${align}" dominant-baseline="text-before-edge" font-family="${escapeXml(element.font || "Inter")}" font-size="${size}" font-weight="${finite(element.weight, 400)}" font-style="${style}" letter-spacing="${finite(element.ls)}"${decoration}${paint(element)}${transform(element)}>${tspans}</text>`;
}

/** Renders the editor's saved page model, replacing named elements with request layer values. */
export function buildEditableTweetSvg(
  document: unknown,
  input: TweetInput,
  avatarDataUrl: string,
): string {
  const candidate = document as EditableTemplateDocument;
  if (!Array.isArray(candidate?.pages) || candidate.pages.length === 0) {
    throw new Error("editable template must contain a page");
  }
  const active = Math.max(0, Math.min(candidate.pages.length - 1, Math.trunc(finite(candidate.active))));
  const page = candidate.pages[active];
  const width = boundedDimension(page.w, "width");
  const height = boundedDimension(page.h, "height");
  if (!Array.isArray(page.els) || page.els.length > 200) throw new Error("invalid editable template elements");

  const dynamicText: Record<string, string> = {
    displayName: input.displayName,
    handle: input.handle,
    tweetText: input.tweetText,
  };

  const definitions: string[] = [];
  const content: string[] = [];
  page.els.forEach((element, index) => {
    if (!element || element.hidden) return;
    const x = finite(element.x);
    const y = finite(element.y);
    const w = Math.max(0, finite(element.w));
    const h = Math.max(0, finite(element.h));
    const radius = Math.max(0, finite(element.radius));

    if (element.type === "text") {
      content.push(renderText(element, dynamicText[element.name || ""] ?? String(element.text || "")));
      return;
    }
    if (element.type === "image") {
      const source = element.name === "avatar" ? avatarDataUrl : String(element.src || "");
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
