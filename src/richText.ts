import type { TextRun } from "./types";

/** Só os campos de estilo de um `TextRun`, sem `text` — o que muda quando você aplica uma cor
 *  (ou peso/itálico/fonte) a um trecho selecionado. */
export type StyleOverride = Pick<TextRun, "font" | "weight" | "italic" | "underline" | "strike" | "fill" | "size">;

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
    segs.push({ start: pos, end, style: { font: r.font, weight: r.weight, italic: r.italic, underline: r.underline, strike: r.strike, fill: r.fill, size: r.size } });
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
  return a.font === b.font && a.weight === b.weight && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike && a.fill === b.fill && a.size === b.size;
}

/** Remove chaves `undefined` — sem isso, todo run ganharia `font: undefined, weight: undefined…`
 *  de propósito nenhum (JSON.stringify já ignora undefined, mas a leitura direta do objeto no
 *  editor não deveria mostrar lixo). */
function cleanStyle(style: StyleOverride): StyleOverride {
  const out: StyleOverride = {};
  for (const k of ["font", "weight", "italic", "underline", "strike", "fill", "size"] as const) {
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

/** O trecho `[start,end)` INTEIRO satisfaz `pred` (estilo efetivo = run por cima do elemento)?
 *  É o que decide se B/I/U da seleção liga ou desliga — igual Docs/Canva: se todo o trecho já
 *  está em negrito, clicar tira; se só parte está, clicar põe em tudo. */
export function rangeEvery(
  text: string,
  runs: TextRun[] | undefined,
  rangeStart: number,
  rangeEnd: number,
  base: StyleOverride,
  pred: (style: StyleOverride) => boolean,
): boolean {
  const start = Math.min(rangeStart, rangeEnd), end = Math.max(rangeStart, rangeEnd);
  return segmentsFromRuns(text, runs)
    .filter((s) => s.end > start && s.start < end)
    .every((s) => pred({ ...base, ...cleanStyle(s.style) }));
}

/** Runs a partir do conteúdo de uma caixa em edição (`contenteditable`): cada nó de texto
 *  herda o estilo do `<span>` mais próximo. Recebe só o que interessa de cada nó, pra ser
 *  testável sem DOM. Quebras de linha já chegam como "\n" no texto dos pedaços. */
export function runsFromPieces(pieces: Array<{ text: string; style: StyleOverride }>): TextRun[] {
  const out: TextRun[] = [];
  for (const p of pieces) {
    if (!p.text) continue;
    const style = cleanStyle(p.style);
    const last = out[out.length - 1];
    if (last && stylesEqual(cleanStyle(last), style)) last.text += p.text;
    else out.push({ text: p.text, ...style });
  }
  return out;
}
