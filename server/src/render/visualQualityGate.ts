import { wrapText } from "./wrapText.ts";

/** Subconjunto de `El` (src/types.ts) que o gate precisa — não importa o tipo completo do
 *  editor pra não acoplar este módulo de servidor ao pacote do front-end. */
export interface QualityElement {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  text?: string;
  size?: number;
  font?: string;
  lh?: number;
  /** Quando true, o renderer encolhe a fonte pra caber na caixa antes de desenhar — um
   *  `size`/`lh` nominal maior que a caixa é esperado nesse caso, não um defeito. Sem checar
   *  isso o gate deu falso positivo real: um import de PDF (51MB, "Prosa Sertaneja") marcou
   *  22 avisos de "estouro" em texto que renderizava visualmente correto, porque autoFit já
   *  compensava antes do desenho. */
  autoFit?: boolean;
}

export interface QualityPage {
  w: number;
  h: number;
  els: QualityElement[];
}

export type QualityIssueKind = "duplicate_crooked_shape" | "text_overflow";

export interface QualityIssue {
  kind: QualityIssueKind;
  elementIds: string[];
  /** Probabilidade/gravidade calibrada pelo Jev, 0..1 — não um booleano de limiar fixo. */
  probability: number;
  detail: string;
}

interface JevAnswer {
  noul?: number;
  score?: number;
  confidence?: number;
}

export interface JevClient {
  ask(state: unknown, questions: Record<string, unknown>): Promise<Record<string, JevAnswer>>;
}

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

/** Cliente HTTP fino pro endpoint de avaliação do Jev — sem SDK, só a chamada crua que a API
 *  documenta (state + questions tipadas, resposta com probabilidade calibrada por pergunta). */
export function createJevClient(apiKey: string): JevClient {
  return {
    async ask(state, questions) {
      const res = await fetch(TYPESAFE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model: "jev-latest", questions }),
      });
      if (!res.ok) throw new Error(`Jev request failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { answers?: Record<string, JevAnswer> };
      return body.answers ?? {};
    },
  };
}

const SHAPE_TYPES = new Set(["line", "rect", "draw"]);

/** `pad` expande as duas caixas antes de cruzar — sem isso, duas linhas finas (h de poucos
 *  pixels) desalinhadas verticalmente por mais que a própria espessura NUNCA se tocam pela
 *  interseção de bbox crua, mesmo sendo visualmente a mesma "linha dupla torta" que este gate
 *  existe pra pegar (caso real: duas linhas h=3, uma em y=819 e outra em y=805 — bbox sem
 *  padding dá interseção zero). O padding é relativo ao tamanho da página, não um pixel fixo,
 *  pra escalar com o tamanho do design. */
function bboxOverlapRatio(a: QualityElement, b: QualityElement, pad: number): number {
  // As duas caixas usadas pra interseção E pra área têm que ser as MESMAS (ambas já expandidas
  // por `pad`) — misturar caixa expandida na interseção com caixa original na área permite uma
  // interseção "maior que a própria forma", dando união negativa e o ratio quebrado.
  const aPadded = { x: a.x - pad, y: a.y - pad, w: a.w + 2 * pad, h: a.h + 2 * pad };
  const bPadded = { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
  const x1 = Math.max(aPadded.x, bPadded.x);
  const y1 = Math.max(aPadded.y, bPadded.y);
  const x2 = Math.min(aPadded.x + aPadded.w, bPadded.x + bPadded.w);
  const y2 = Math.min(aPadded.y + aPadded.h, bPadded.y + bPadded.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = aPadded.w * aPadded.h + bPadded.w * bPadded.h - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Pré-filtro barato, em código: só formas com caixas bem sobrepostas (já com a folga de `pad`)
 *  MAS ângulo/posição diferente viram candidatas — evita perguntar ao Jev sobre pares de formas
 *  óbvias que não têm nada a ver uma com a outra. */
function findNearDuplicateShapes(els: QualityElement[], pad: number): Array<[QualityElement, QualityElement]> {
  const shapes = els.filter((e) => SHAPE_TYPES.has(e.type));
  const pairs: Array<[QualityElement, QualityElement]> = [];
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const a = shapes[i];
      const b = shapes[j];
      if (bboxOverlapRatio(a, b, pad) < 0.3) continue;
      if (a.rot === b.rot && a.x === b.x && a.y === b.y) continue; // idênticas não são "duplicata torta"
      pairs.push([a, b]);
    }
  }
  return pairs;
}

/** ~2% da maior dimensão da página — o bastante pra cobrir o desalinhamento típico de um
 *  defeito de import/geração sem virar candidata qualquer par de formas distantes. */
function shapeProximityPadding(page: QualityPage): number {
  return Math.max(page.w, page.h) * 0.02;
}

/** Reusa o wrapText real do renderer (mesma métrica de largura de glifo já usada pra desenhar
 *  o texto de verdade) em vez de inventar uma segunda heurística só pro gate. Retorna null
 *  quando não há dado suficiente pra estimar (sem tamanho/caixa/texto). */
function estimateOverflowRatio(el: QualityElement): number | null {
  if (el.type !== "text" || !el.text || !el.size || !el.w || !el.h || el.autoFit) return null;
  const lines = wrapText(el.text, el.w, el.size, el.font);
  const lineHeight = el.size * (el.lh ?? 1.25);
  return (lines.length * lineHeight) / el.h;
}

const DUPLICATE_SHAPE_THRESHOLD = 0.6;
const TEXT_OVERFLOW_SCORE_THRESHOLD = 1.5; // nível "estouro sério" na escala 0..2 abaixo

/**
 * Gate de qualidade visual sobre os DADOS estruturados de uma página (posição/tamanho/rotação),
 * não sobre a imagem renderizada — Jev não é um modelo de visão. Código faz a triagem barata
 * (overlap de bbox, quebra de linha real via wrapText); o Jev só responde ao julgamento
 * semântico que sobra ("isso parece um defeito de import/geração, ou é intencional?").
 */
export async function checkPageVisualQuality(page: QualityPage, jev: JevClient): Promise<QualityIssue[]> {
  const questions: Record<string, unknown> = {};
  const lookup = new Map<string, { kind: QualityIssueKind; elementIds: string[]; detail: string }>();

  findNearDuplicateShapes(page.els, shapeProximityPadding(page)).forEach(([a, b], index) => {
    const key = `linha_duplicada_${index}`;
    questions[key] = {
      type: "noul",
      instructions: {
        contexto:
          "Dois elementos gráficos com caixas quase sobrepostas, num design gerado por import de PDF ou por API.",
        elemento_a: { tipo: a.type, x: a.x, y: a.y, w: a.w, h: a.h, rot: a.rot },
        elemento_b: { tipo: b.type, x: b.x, y: b.y, w: b.w, h: b.h, rot: b.rot },
        pergunta:
          "Isso parece uma duplicata torta/quebrada de um único traço reto pretendido (ex.: uma linha decorativa), em vez de duas formas intencionalmente distintas?",
      },
      criteria: {
        true: "As duas formas quase coincidem em posição mas o ângulo diverge o suficiente pra parecer um X ou serrilhado — defeito de import/geração",
        false: "As formas são claramente distintas de propósito (tamanhos/posições diferentes o bastante pra compor um desenho intencional)",
      },
    };
    lookup.set(key, {
      kind: "duplicate_crooked_shape",
      elementIds: [a.id, b.id],
      detail: `formas ${a.id} e ${b.id} quase sobrepostas com ângulos diferentes (${a.rot}° vs ${b.rot}°)`,
    });
  });

  for (const el of page.els) {
    const ratio = estimateOverflowRatio(el);
    if (ratio === null || ratio < 1.05) continue; // só pergunta quando já parece estourar de verdade
    const key = `estouro_${el.id}`;
    questions[key] = {
      type: "score",
      instructions: {
        contexto:
          "Texto de um design (import de PDF ou geração via API) cujo tamanho estimado, calculado por quebra de linha real, ultrapassa a altura da própria caixa.",
        caixa: { w: el.w, h: el.h },
        proporcao_estimada_vs_caixa: Number(ratio.toFixed(2)),
        pergunta: "Dado que o texto quebrado ocupa essa proporção da altura da caixa, o quão grave é o estouro visual esperado?",
      },
      criteria: [
        "Estouro desprezível — cabe na prática (folga de renderização absorve a diferença)",
        "Estouro leve — perceptível mas não quebra o layout",
        "Estouro sério — invade visivelmente outro elemento ou sai da página",
      ],
    };
    lookup.set(key, {
      kind: "text_overflow",
      elementIds: [el.id],
      detail: `texto ${el.id}: altura estimada em ${(ratio * 100).toFixed(0)}% da caixa`,
    });
  }

  if (Object.keys(questions).length === 0) return [];

  const answers = await jev.ask({ pagina: { w: page.w, h: page.h } }, questions);
  const issues: QualityIssue[] = [];
  for (const [key, meta] of lookup) {
    const answer = answers[key];
    if (!answer) continue;
    if (meta.kind === "duplicate_crooked_shape" && (answer.noul ?? 0) >= DUPLICATE_SHAPE_THRESHOLD) {
      issues.push({ kind: meta.kind, elementIds: meta.elementIds, probability: answer.noul!, detail: meta.detail });
    }
    if (meta.kind === "text_overflow" && (answer.score ?? 0) >= TEXT_OVERFLOW_SCORE_THRESHOLD) {
      issues.push({ kind: meta.kind, elementIds: meta.elementIds, probability: (answer.score ?? 0) / 2, detail: meta.detail });
    }
  }
  return issues;
}

/** Roda o gate em todas as páginas de um documento, uma chamada ao Jev por página que tiver
 *  candidato — páginas sem nada suspeito não geram chamada nenhuma. */
export async function checkDocumentVisualQuality(
  pages: readonly QualityPage[],
  jev: JevClient,
): Promise<Array<{ pageIndex: number; issues: QualityIssue[] }>> {
  const results = await Promise.all(
    pages.map(async (page, pageIndex) => ({ pageIndex, issues: await checkPageVisualQuality(page, jev) })),
  );
  return results.filter((r) => r.issues.length > 0);
}
