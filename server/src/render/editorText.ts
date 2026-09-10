import { escapeXml } from "./svg.ts";

export interface TextStyle {
  font?: string;
  weight?: number;
  italic?: boolean;
  underline?: boolean;
  fill?: string;
}
export interface EditorText extends TextStyle {
  id?: string;
  text?: string;
  size?: number;
  align?: string;
  lh?: number;
  ls?: number;
  runs?: Array<TextStyle & { text: string }>;
}

function family(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\3c ");
}
function color(value: string): string {
  return /[;{}<>]/.test(value) ? "inherit" : value;
}

export function textRunsHtml(e: EditorText): string {
  if (!e.runs?.length) return escapeXml(e.text ?? "");
  return e.runs.map(r => {
    const style = [
      r.font ? `font-family:${family(r.font)},Inter,system-ui,sans-serif` : "",
      r.weight !== undefined ? `font-weight:${Number(r.weight) || 400}` : "",
      r.italic !== undefined ? `font-style:${r.italic ? "italic" : "normal"}` : "",
      r.underline !== undefined ? `text-decoration:${r.underline ? "underline" : "none"}` : "",
      r.fill ? `color:${color(r.fill)}` : "",
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
    `text-decoration:${e.underline ? "underline" : "none"}`,
    `text-align:${["left", "right", "center", "justify"].includes(e.align || "") ? e.align : "left"}`,
    `line-height:${Number(e.lh) || 1.2}`, `letter-spacing:${Number(e.ls) || 0}px`,
    `color:${color(e.fill || "#000000")}`, "white-space:pre-wrap", "word-break:break-word", "-webkit-font-smoothing:antialiased",
  ].join(";");
  return `<div class="txt" data-txt="${escapeXml(e.id || "")}" style="${escapeXml(style)}">${textRunsHtml(e)}</div>`;
}
