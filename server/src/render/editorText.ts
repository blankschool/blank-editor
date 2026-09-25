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
  fill?: string;
  textFx?: TextFx;
  /** Curvatura: -100 (sorriso) … 100 (arco). 0/ausente = reto. */
  curve?: number;
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

/** Efeito de texto, um por vez como no Canva: sombra, contorno, vazado, fundo, degradê. */
export interface TextFx {
  type: "shadow" | "outline" | "hollow" | "bg" | "grad";
  color?: string;
  /** Intensidade: deslocamento da sombra, espessura do contorno, respiro do fundo (px). */
  size?: number;
  /** Só "grad". */
  stops?: Array<[string, number]>;
  angle?: number;
}

export function textFxCss(fx: TextFx | undefined, fontSize: number): string[] {
  if (!fx) return [];
  const c = color(fx.color || "#000000");
  const n = Number(fx.size) || Math.max(1, fontSize / 20);
  switch (fx.type) {
    case "shadow": return [`text-shadow:${n}px ${n}px ${n * 1.5}px ${c}`];
    case "outline": return [`-webkit-text-stroke:${n}px ${c}`, "paint-order:stroke fill"];
    case "hollow": return [`-webkit-text-stroke:${n}px ${c}`, "-webkit-text-fill-color:transparent"];
    case "bg": return [`background:${c}`, `padding:${n}px ${n * 1.4}px`, `border-radius:${n}px`, "box-decoration-break:clone", "-webkit-box-decoration-break:clone"];
    case "grad": {
      const stops = (fx.stops?.length ? fx.stops : [["#ff5f6d", 0], ["#ffc371", 1]] as Array<[string, number]>)
        .map(([sc, p]) => `${color(sc)} ${(p * 100).toFixed(1)}%`).join(",");
      return [`background:linear-gradient(${Number(fx.angle) || 90}deg,${stops})`, "-webkit-background-clip:text", "background-clip:text", "-webkit-text-fill-color:transparent"];
    }
  }
  return [];
}

/** Geometria do texto curvo, compartilhada pelo SVG (editor/servidor) e pelo canvas (export):
 *  o texto corre num arco de círculo cujo comprimento é a largura da caixa. */
export function curveGeometry(w: number, h: number, size: number, curve: number, arcLength = w) {
  const theta = Math.max(0.05, Math.min(1, Math.abs(curve) / 100)) * 1.9 * Math.PI;
  const r = arcLength / theta;
  const up = curve > 0;
  const base = h / 2 + size * 0.35;
  const cx = w / 2, cy = up ? base + r : base - r;
  const a0 = up ? -Math.PI / 2 - theta / 2 : Math.PI / 2 + theta / 2;
  const a1 = up ? -Math.PI / 2 + theta / 2 : Math.PI / 2 - theta / 2;
  const p = (a: number) => `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  const d = `M${p(a0)} A${r.toFixed(2)},${r.toFixed(2)} 0 ${theta > Math.PI ? 1 : 0} ${up ? 1 : 0} ${p(a1)}`;
  return { cx, cy, r, a0, dir: up ? 1 : -1, d };
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
    ...textFxCss(e.textFx, Number(e.size) || 15),
    ...(e.curve ? ["color:transparent", "-webkit-text-fill-color:transparent", "-webkit-text-stroke:0", "text-shadow:none", "background:none"] : []),
  ].join(";");
  const fit = e.autoFit && e.w && e.h ? ` data-auto-fit="${Number(e.size) || 15}" data-fit-width="${Number(e.w)}" data-fit-height="${Number(e.h)}"` : "";
  const flat = `<div class="txt" data-txt="${escapeXml(e.id || "")}"${fit} style="${escapeXml(style)}">${textRunsHtml(e)}</div>`;
  return e.curve ? flat + curvedTextSvg(e) : flat;
}

/** Texto curvo: o `.txt` continua lá (invisível) para edição e medida; o SVG desenha o texto no
 *  arco. Quebras de linha viram espaço — no Canva o texto curvo também é de uma linha só. */
function curvedTextSvg(e: EditorText): string {
  const w = Number(e.w) || 100, h = Number(e.h) || 40, size = Number(e.size) || 15;
  const g = curveGeometry(w, h, size, Number(e.curve));
  const id = `cv${String(e.id || "x").replace(/[^\w-]/g, "")}`;
  const one = (t: string) => escapeXml((e.caps ? t.toUpperCase() : t).replace(/\n/g, " "));
  const spans = e.runs?.length ? e.runs.map(r => {
    const a = [r.font ? `font-family="${escapeXml(r.font)}"` : "", r.weight !== undefined ? `font-weight="${Number(r.weight)}"` : "",
      r.italic ? `font-style="italic"` : "", r.fill ? `fill="${escapeXml(color(r.fill))}"` : "", r.size ? `font-size="${Number(r.size)}"` : ""].filter(Boolean).join(" ");
    return `<tspan ${a}>${one(r.text)}</tspan>`;
  }).join("") : one(e.text ?? "");
  const fx = e.textFx;
  const stroke = fx && (fx.type === "outline" || fx.type === "hollow") ? ` stroke="${escapeXml(color(fx.color || "#000"))}" stroke-width="${Number(fx.size) || size / 20}" paint-order="stroke"` : "";
  const fill = fx?.type === "hollow" ? "none" : escapeXml(color(e.fill || "#000000"));
  return `<svg class="curvesvg" data-curve="${Number(e.curve)}" data-size="${size}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="position:absolute;left:0;top:0;overflow:visible;pointer-events:none">` +
    `<path id="${id}" d="${g.d}" fill="none"/>` +
    `<text font-family="${escapeXml(e.font || "Inter")},Inter,sans-serif" font-size="${size}" font-weight="${Number(e.weight) || 400}"${e.italic ? ` font-style="italic"` : ""} letter-spacing="${Number(e.ls) || 0}" fill="${fill}"${stroke}>` +
    `<textPath href="#${id}" startOffset="50%" text-anchor="middle">${spans}</textPath></text></svg>`;
}

/** Runs after fonts load, in both the editor and the server's Chromium page. */
export function fitTextElements(root = (globalThis as any).document): void {
  // Texto curvo: o arco tem o comprimento REAL do texto (medido aqui, depois das fontes),
  // centrado na caixa. Autocontido de propósito — o servidor injeta esta função via toString().
  for (const svg of root.querySelectorAll("svg.curvesvg") as Iterable<any>) {
    const text = svg.querySelector("text"), path = svg.querySelector("path");
    if (!text || !path) continue;
    const L = Math.max(1, text.getComputedTextLength());
    const bw = Number(svg.getAttribute("width")), bh = Number(svg.getAttribute("height"));
    const curve = Number(svg.dataset.curve), size = Number(svg.dataset.size);
    const theta = Math.max(0.05, Math.min(1, Math.abs(curve) / 100)) * 1.9 * Math.PI;
    const r = L / theta, up = curve > 0, base = bh / 2 + size * 0.35;
    const cx = bw / 2, cy = up ? base + r : base - r;
    const a0 = up ? -Math.PI / 2 - theta / 2 : Math.PI / 2 + theta / 2;
    const a1 = up ? -Math.PI / 2 + theta / 2 : Math.PI / 2 - theta / 2;
    const pt = (a: number) => `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
    path.setAttribute("d", `M${pt(a0)} A${r.toFixed(2)},${r.toFixed(2)} 0 ${theta > Math.PI ? 1 : 0} ${up ? 1 : 0} ${pt(a1)}`);
  }
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
