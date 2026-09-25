/**
 * Ações de edição no estilo do Canva que não dependem de DOM: distribuir, lista com
 * marcadores, copiar/colar estilo. Puras para poderem ser testadas.
 */
import type { El, TextRun } from "./types";

/** Espaçamento uniforme entre 3+ elementos (Canva: "Organizar > Espaçamento"): o primeiro e o
 *  último ficam onde estão, os do meio se ajustam para o vão entre bordas ser igual. */
export function distribute(els: Array<Pick<El, "x" | "y" | "w" | "h">>, axis: "h" | "v"): void {
  if (els.length < 3) return;
  const pos = axis === "h" ? "x" : "y", size = axis === "h" ? "w" : "h";
  const sorted = [...els].sort((a, b) => a[pos] + a[size] / 2 - (b[pos] + b[size] / 2));
  const first = sorted[0], last = sorted[sorted.length - 1];
  const total = sorted.reduce((s, e) => s + e[size], 0);
  const gap = (last[pos] + last[size] - first[pos] - total) / (sorted.length - 1);
  let cursor = first[pos] + first[size] + gap;
  for (const e of sorted.slice(1, -1)) {
    e[pos] = Math.round(cursor);
    cursor += e[size] + gap;
  }
}

const BULLET = "• ";

/** Liga/desliga marcador "• " no começo de cada linha, mantendo os trechos de estilo. */
export function toggleBullets(text: string, runs?: TextRun[]): { text: string; runs?: TextRun[] } {
  const lines = text.split("\n");
  const on = !lines.every((l) => l.startsWith(BULLET) || l === "");
  const edit = (s: string, atLineStart: boolean) => {
    // aplica em cada início de linha dentro de `s`
    const parts = s.split("\n");
    return parts.map((p, i) => {
      const start = i > 0 || atLineStart;
      if (!start || p === "" && i === parts.length - 1 && i > 0) return p;
      if (on) return p.startsWith(BULLET) ? p : BULLET + p;
      return p.startsWith(BULLET) ? p.slice(BULLET.length) : p;
    }).join("\n");
  };
  if (!runs?.length) return { text: edit(text, true) };
  let atStart = true;
  const out = runs.map((r) => {
    const t = edit(r.text, atStart);
    atStart = r.text.endsWith("\n");
    return { ...r, text: t };
  });
  return { text: out.map((r) => r.text).join(""), runs: out };
}

const TEXT_STYLE = ["font", "size", "weight", "italic", "underline", "strike", "caps", "fill", "lh", "ls", "align", "shadow", "opacity"] as const;
const SHAPE_STYLE = ["fill", "grad", "stroke", "strokeWidth", "strokeDash", "radius", "opacity", "shadow", "blur", "filter"] as const;

export type CopiedStyle = { kind: "text" | "shape"; props: Partial<El> };

/** Copiar estilo (pincel do Canva): texto leva tipografia/cor, forma/imagem leva
 *  preenchimento/borda/efeitos. Colar só aplica entre tipos compatíveis. */
export function copyStyle(el: El): CopiedStyle {
  const kind = el.type === "text" ? "text" : "shape";
  const keys = kind === "text" ? TEXT_STYLE : SHAPE_STYLE;
  const props: Record<string, unknown> = {};
  for (const k of keys) if ((el as any)[k] !== undefined) props[k] = structuredClone((el as any)[k]);
  return { kind, props: props as Partial<El> };
}

export function pasteStyle(target: El, style: CopiedStyle): boolean {
  const kind = target.type === "text" ? "text" : "shape";
  if (kind !== style.kind) return false;
  Object.assign(target, structuredClone(style.props));
  if (kind === "text") delete target.runs; // o estilo copiado vale para a caixa inteira
  if (kind === "shape" && !style.props.grad) delete target.grad;
  return true;
}
