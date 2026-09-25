/**
 * Ordem de camadas do design importado = ordem REAL de pintura do PDF.
 *
 * Texto e forma já chegam do Python com `z` (índice em `page.get_bboxlog()`). As imagens vêm do
 * poppler (extractImages.ts), que não sabe a ordem — então cada camada de imagem herda o `z` da
 * imagem do PDF cuja bbox mais se sobrepõe à dela (IoU), lida pelo Python em `images`.
 */
import type { ImageOrder } from "./pythonExtract.ts";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** `z` da imagem do PDF que corresponde a `box` (em px), ou `null` sem correspondência
 *  razoável. Cada ordem só é usada uma vez — duas camadas idênticas (a mesma foto repetida)
 *  recebem as duas ordens, na sequência. */
export function assignImageZ(boxesPx: Box[], orders: ImageOrder[], ptToPx: number): Array<number | null> {
  const disponiveis = orders.map((o) => ({
    z: o.z,
    box: { x: o.bbox[0] * ptToPx, y: o.bbox[1] * ptToPx, w: (o.bbox[2] - o.bbox[0]) * ptToPx, h: (o.bbox[3] - o.bbox[1]) * ptToPx },
    usada: false,
  }));
  return boxesPx.map((box) => {
    let melhor: (typeof disponiveis)[number] | null = null;
    let melhorIou = 0.5;
    for (const cand of disponiveis) {
      if (cand.usada) continue;
      const v = iou(box, cand.box);
      if (v > melhorIou || (v === melhorIou && melhor && cand.z < melhor.z)) {
        melhor = cand;
        melhorIou = v;
      }
    }
    if (!melhor) return null;
    melhor.usada = true;
    return melhor.z;
  });
}

/** Ordena estável por `z`. Elemento sem `z` conhecido vai para o fundo (z = -1): na prática é
 *  uma imagem que o casamento por bbox não achou, e o fundo é o palpite menos destrutivo — uma
 *  foto na frente de tudo esconderia o texto. */
export function sortByPaintOrder<T extends { z?: number | null }>(elements: T[]): T[] {
  return elements
    .map((el, i) => ({ el, i, z: el.z ?? -1 }))
    .sort((a, b) => a.z - b.z || a.i - b.i)
    .map(({ el }) => el);
}
