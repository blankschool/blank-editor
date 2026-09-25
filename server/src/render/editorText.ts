import { escapeXml } from "./svg.ts";

export interface TextStyle {
  font?: string;
  weight?: number;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fill?: string;
  size?: number;
}
export interface EditorText extends TextStyle {
  id?: string;
  text?: string;
  size?: number;
  align?: string;
  lh?: number;
  ls?: number;
  caps?: boolean;
  runs?: Array<TextStyle & { text: string }>;
  autoFit?: boolean;
  w?: number;
  h?: number;
}

function family(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\3c ");
}
function color(value: string): string {
  return /[;{}<>]/.test(value) ? "inherit" : value;
}

function decoration(underline?: boolean, strike?: boolean): string {
  return [underline ? "underline" : "", strike ? "line-through" : ""].filter(Boolean).join(" ") || "none";
}

export function textRunsHtml(e: EditorText): string {
  if (!e.runs?.length) return escapeXml(e.text ?? "");
  const base = Number(e.size) || 15;
  return e.runs.map(r => {
    const style = [
      r.font ? `font-family:${family(r.font)},Inter,system-ui,sans-serif` : "",
      r.weight !== undefined ? `font-weight:${Number(r.weight) || 400}` : "",
      r.italic !== undefined ? `font-style:${r.italic ? "italic" : "normal"}` : "",
      r.underline !== undefined || r.strike !== undefined ? `text-decoration:${decoration(r.underline, r.strike)}` : "",
      r.fill ? `color:${color(r.fill)}` : "",
      // Em `em` do corpo da caixa: o autoFit encolhe a caixa inteira e o trecho acompanha.
      r.size ? `font-size:${(Number(r.size) / base).toFixed(4)}em` : "",
    ].filter(Boolean).join(";");
    return `<span style="${escapeXml(style)}">${escapeXml(r.text)}</span>`;
  }).join("");
}

/** Shared by the live editor and API: browser line layout is the source of truth. */
export function editorTextHtml(e: EditorText): string {
  const style = [
    `font-family:${family(e.font || "Inter")},Inter,system-ui,sans-serif`,
    `font-size:${Number(e.size) || 15}px`, `font-weight:${Number(e.weight) || 400}`,
    `font-style:${e.italic ? "italic" : "normal"}`,
    `text-decoration:${decoration(e.underline, e.strike)}`,
    ...(e.caps ? ["text-transform:uppercase"] : []),
    `text-align:${["left", "right", "center", "justify"].includes(e.align || "") ? e.align : "left"}`,
    `line-height:${Number(e.lh) || 1.2}`, `letter-spacing:${Number(e.ls) || 0}px`,
    `color:${color(e.fill || "#000000")}`, "white-space:pre-wrap", "word-break:break-word", "-webkit-font-smoothing:antialiased",
  ].join(";");
  const fit = e.autoFit && e.w && e.h ? ` data-auto-fit="${Number(e.size) || 15}" data-fit-width="${Number(e.w)}" data-fit-height="${Number(e.h)}"` : "";
  return `<div class="txt" data-txt="${escapeXml(e.id || "")}"${fit} style="${escapeXml(style)}">${textRunsHtml(e)}</div>`;
}

/** Runs after fonts load, in both the editor and the server's Chromium page. */
export function fitTextElements(root = (globalThis as any).document): void {
  for (const node of root.querySelectorAll("[data-auto-fit]") as Iterable<any>) {
    const original = Number(node.dataset.autoFit);
    const width = Number(node.dataset.fitWidth), height = Number(node.dataset.fitHeight);
    const fits = () => node.scrollHeight <= Math.ceil(height) && node.scrollWidth <= Math.ceil(width);
    node.style.fontSize = `${original}px`;
    if (fits()) continue;
    let low = 1, high = original;
    for (let i = 0; i < 16; i++) {
      const size = (low + high) / 2;
      node.style.fontSize = `${size}px`;
      if (fits()) low = size; else high = size;
    }
    node.style.fontSize = `${low}px`;
  }
}
