import type { FaceRef } from "./fontCache.ts";
import { DEFAULT_FONT_FAMILY } from "./editableTweetTemplate.ts";

/**
 * Decide QUAIS faces uma renderização precisa, e recusa alto quando não dá para decidir.
 *
 * O rasterizador roda com `loadSystemFonts: false` — nada instalado na máquina influencia o
 * resultado. Isso é a propriedade que se quer (o mesmo documento desenha igual em qualquer
 * lugar), mas troca um modo de falha por outro: uma família que o documento usa e não declara
 * não cai mais numa fonte parecida, ela simplesmente não desenha. Texto invisível é pior do
 * que texto feio, e some sem erro nenhum.
 *
 * Por isso tudo aqui lança em vez de seguir. O bug que originou este módulo foi exatamente uma
 * falha silenciosa: uma camada de imagem descartada sem aviso porque o `src` não tinha o
 * formato esperado.
 */

interface Textish {
  type?: string;
  name?: string;
  font?: string;
  hidden?: boolean;
}

/** Famílias que os elementos de texto desta página realmente pedem. */
export function listUsedFamilies(page: { els?: unknown } | null | undefined): string[] {
  const els = Array.isArray(page?.els) ? (page.els as Textish[]) : [];
  const used = new Set<string>();
  for (const el of els) {
    if (!el || el.type !== "text" || el.hidden) continue;
    // O default entra na conta: o SVG vai pedir essa família de qualquer forma, então ela
    // precisa ser exigida aqui também.
    used.add((el.font || "").trim() || DEFAULT_FONT_FAMILY);
  }
  return [...used];
}

/**
 * Casa as famílias usadas com as faces declaradas em `Doc.fonts`.
 *
 * Devolve só as faces das famílias efetivamente usadas: carregar as outras seria trabalho
 * jogado fora, e um design pode declarar faces que a página atual não usa (um carrossel cuja
 * capa não tem a fonte do miolo).
 */
export function resolveFaces(declared: readonly FaceRef[], usedFamilies: readonly string[]): FaceRef[] {
  const byFamily = new Map<string, FaceRef[]>();
  for (const face of declared) {
    const list = byFamily.get(face.family) ?? [];
    list.push(face);
    byFamily.set(face.family, list);
  }

  const faltando = usedFamilies.filter((family) => !byFamily.has(family));
  if (faltando.length) {
    throw new Error(
      `o documento usa ${faltando.length === 1 ? "a família" : "as famílias"} ${faltando.map((f) => `"${f}"`).join(", ")} ` +
        `mas não declara nenhuma face para ${faltando.length === 1 ? "ela" : "elas"} em Doc.fonts. ` +
        `Sem isso o texto sairia em branco, então o render para aqui.`,
    );
  }

  const escolhidas: FaceRef[] = [];
  for (const family of usedFamilies) {
    const faces = byFamily.get(family)!;
    // Duas faces com a mesma família E o mesmo peso, mas bytes diferentes: o rasterizador
    // escolheria uma das duas por critério próprio, e o resultado viraria loteria entre
    // deploys. Melhor recusar e obrigar quem montou o documento a desambiguar.
    const porPeso = new Map<number, Set<string>>();
    for (const face of faces) {
      const shas = porPeso.get(face.weight) ?? new Set<string>();
      shas.add(face.sha256);
      porPeso.set(face.weight, shas);
    }
    for (const [weight, shas] of porPeso) {
      if (shas.size > 1) {
        throw new Error(
          `a família "${family}" peso ${weight} foi declarada com ${shas.size} arquivos diferentes ` +
            `(${[...shas].map((s) => s.slice(0, 12)).join(", ")}). Ambíguo: o render para aqui em vez de sortear.`,
        );
      }
    }
    escolhidas.push(...faces);
  }
  return escolhidas;
}

/** O texto que cada elemento vai realmente desenhar — o override da requisição, ou o que o
 *  documento guardou. Precisa casar com o que `buildTemplateSvg` usa, senão a verificação de
 *  cobertura confere a string errada. */
function textoDe(el: Textish & { name?: string; text?: unknown }, texts: Record<string, string>): string {
  return texts[el.name || ""] ?? String(el.text ?? "");
}

/** A face que o rasterizador vai escolher para um elemento: mesma família, peso mais próximo. */
function faceParaElemento(faces: readonly FaceRef[], family: string, weight: number): FaceRef | undefined {
  const daFamilia = faces.filter((f) => f.family === family);
  if (!daFamilia.length) return undefined;
  return daFamilia.reduce((melhor, f) =>
    Math.abs(f.weight - weight) < Math.abs(melhor.weight - weight) ? f : melhor);
}

/**
 * Recusa um texto que a fonte não sabe desenhar.
 *
 * Uma face extraída de PDF é um SUBSET: traz só os glifos que a arte original usava.
 * `NYTFranklin-Light` tem `?acdegilmnoruvó` e mais nada. Pedir a ela uma palavra com "b" não
 * produz erro em lugar nenhum — o rasterizador emite um aviso no log e desenha o vazio, e o
 * cliente da API recebe um PNG com um buraco no lugar da manchete.
 *
 * Faces sem `glyphs` declarado são fontes completas e não são verificadas.
 */
export function assertGlyphCoverage(
  page: { els?: unknown } | null | undefined,
  texts: Record<string, string>,
  faces: readonly FaceRef[],
): void {
  const els = Array.isArray(page?.els) ? (page.els as Array<Textish & { weight?: number; text?: unknown }>) : [];
  for (const el of els) {
    if (!el || el.type !== "text" || el.hidden) continue;
    const family = (el.font || "").trim() || DEFAULT_FONT_FAMILY;
    const face = faceParaElemento(faces, family, Number(el.weight) || 400);
    if (!face?.glyphs) continue;

    const disponiveis = new Set([...face.glyphs]);
    const faltando = [...new Set([...textoDe(el, texts)])]
      .filter((ch) => ch !== "\n" && ch !== "\r" && !disponiveis.has(ch));
    if (faltando.length) {
      const lista = faltando.map((ch) => `"${ch}" (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`).join(", ");
      throw new Error(
        `a camada "${el.name || "(sem nome)"}" pede ${lista} da fonte ${family} peso ${face.weight}, ` +
          `mas essa face é um subset e não tem esses glifos. Sairiam em branco, então o render para aqui.`,
      );
    }
  }
}
