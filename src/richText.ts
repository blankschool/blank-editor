import type { TextRun } from "./types";

/** Só os campos de estilo de um `TextRun`, sem `text` — o que muda quando você aplica uma cor
 *  (ou peso/itálico/fonte) a um trecho selecionado. */
export type StyleOverride = Pick<TextRun, "font" | "weight" | "italic" | "underline" | "fill">;

interface Segment {
  start: number;
  end: number;
  style: StyleOverride;
}

/** `runs` vira uma lista de segmentos com offset absoluto — sem `runs` (texto ainda plano), um
 *  segmento só, sem override nenhum, cobrindo o texto inteiro. */
function segmentsFromRuns(text: string, runs: TextRun[] | undefined): Segment[] {
  if (!runs || !runs.length) {
    return text.length ? [{ start: 0, end: text.length, style: {} }] : [];
  }
  const segs: Segment[] = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.text.length;
    segs.push({ start: pos, end, style: { font: r.font, weight: r.weight, italic: r.italic, underline: r.underline, fill: r.fill } });
    pos = end;
  }
  return segs;
}

/** Corta qualquer segmento que atravesse `offset` em dois, mantendo o mesmo estilo dos dois
 *  lados — é o que permite que um override só valha DENTRO de [start,end), nunca além. */
function splitAt(segs: Segment[], offset: number): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    if (offset > s.start && offset < s.end) {
      out.push({ start: s.start, end: offset, style: s.style });
      out.push({ start: offset, end: s.end, style: s.style });
    } else {
      out.push(s);
    }
  }
  return out;
}

function stylesEqual(a: StyleOverride, b: StyleOverride): boolean {
  return a.font === b.font && a.weight === b.weight && a.italic === b.italic && a.underline === b.underline && a.fill === b.fill;
}

/** Remove chaves `undefined` — sem isso, todo run ganharia `font: undefined, weight: undefined…`
 *  de propósito nenhum (JSON.stringify já ignora undefined, mas a leitura direta do objeto no
 *  editor não deveria mostrar lixo). */
function cleanStyle(style: StyleOverride): StyleOverride {
  const out: StyleOverride = {};
  for (const k of ["font", "weight", "italic", "underline", "fill"] as const) {
    if (style[k] !== undefined) (out as any)[k] = style[k];
  }
  return out;
}

/** Aplica um override de estilo (cor, peso, itálico…) só ao trecho `[start,end)` do texto,
 *  devolvendo o novo `runs` — o resto do texto mantém o estilo que já tinha (seus próprios runs
 *  anteriores, ou nenhum override se o texto ainda era plano). `start`/`end` são índices de
 *  caractere em `text`, não em `runs`. Segmentos adjacentes com o MESMO estilo resultante são
 *  mesclados de volta, pra não fragmentar o texto num run por caractere a cada aplicação. */
export function applyStyleToRange(
  text: string,
  runs: TextRun[] | undefined,
  rangeStart: number,
  rangeEnd: number,
  override: StyleOverride,
): TextRun[] {
  const start = Math.max(0, Math.min(text.length, Math.min(rangeStart, rangeEnd)));
  const end = Math.max(0, Math.min(text.length, Math.max(rangeStart, rangeEnd)));
  if (start >= end) return runs ?? [];

  let segs = segmentsFromRuns(text, runs);
  segs = splitAt(segs, start);
  segs = splitAt(segs, end);
  segs = segs.map((s) => ({
    ...s,
    style: cleanStyle(s.start >= start && s.end <= end ? { ...s.style, ...override } : s.style),
  }));

  const merged: Segment[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.end === s.start && stylesEqual(last.style, s.style)) last.end = s.end;
    else merged.push({ ...s });
  }
  return merged.map((s) => ({ text: text.slice(s.start, s.end), ...s.style }));
}
