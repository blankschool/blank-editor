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
  runs?: Array<{ font?: string }>;
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
    for (const run of el.runs ?? []) if (run.font) used.add(run.font);
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
export function resolveFaces(declared: readonly FaceRef[], usedFamilies: readonly string[], useBrowserPrecedence = false): FaceRef[] {
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
    // Chromium uses ordered @font-face declarations, just like the editor's FontFace
    // registrations. Glyph metadata is optional; the font files provide coverage.
    // The legacy SVG rasterizer still needs an unambiguous family/weight pair.
    const porPeso = new Map<string, Set<string>>();
    for (const face of faces) {
      const key = `${face.weight}/${face.style || "normal"}`;
      const shas = porPeso.get(key) ?? new Set<string>();
      shas.add(face.sha256);
      porPeso.set(key, shas);
    }
    for (const [variant, shas] of porPeso) {
      const weight = variant.split("/")[0];
      if (shas.size > 1 && !useBrowserPrecedence) {
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
 * Devolve `page.els` com `font`/`weight` trocados para a família de `fallback` (a Inter
 * embutida, sempre completa) em qualquer elemento de texto cuja face declarada seja um SUBSET
 * que não cubra o texto que ele realmente vai desenhar.
 *
 * Precisa mudar o ELEMENTO, não só o arquivo carregado: o resvg casa `font-family` do SVG pelo
 * nome que o próprio arquivo de fonte declara por dentro (tabela `name`), então trocar o
 * arquivo sem trocar o `font-family` do texto deixa a camada sem nenhuma face que bata —
 * mesmo efeito de família ausente, mas silencioso (nenhum glifo desenha, sem erro).
 *
 * Existe porque um subset extraído de PDF só tem os glifos que a arte original usava (ver
 * `assertGlyphCoverage`); editar o texto de uma camada por API pode pedir uma letra que nunca
 * esteve lá. Antes disso o render inteiro recusava. Preferimos desenhar com uma fonte PARECIDA
 * do que travar — a mesma escolha já feita para família totalmente ausente (`builtinFaces.ts`)
 * e para fonte de PDF não reconstruída (`canva-pdf-fonts.py`).
 *
 * Quando não há fallback pra aquele peso, o elemento sai como veio — `assertGlyphCoverage`
 * continua como rede de segurança final.
 */
export function elementsWithGlyphFallback(
  page: { els?: unknown } | null | undefined,
  texts: Record<string, string>,
  faces: readonly FaceRef[],
  fallback: readonly FaceRef[],
): unknown[] {
  const els = Array.isArray(page?.els) ? (page.els as Array<Textish & { weight?: number; text?: unknown }>) : [];
  return els.map((el) => {
    if (!el || el.type !== "text" || el.hidden) return el;
    const family = (el.font || "").trim() || DEFAULT_FONT_FAMILY;
    const weight = Number(el.weight) || 400;
    const face = faceParaElemento(faces, family, weight);
    if (!face?.glyphs) return el;

    const disponiveis = new Set([...face.glyphs]);
    const cobre = [...new Set([...textoDe(el, texts)])]
      .every((ch) => ch === "\n" || ch === "\r" || disponiveis.has(ch));
    if (cobre) return el;

    const substituta = faceParaElemento(fallback, DEFAULT_FONT_FAMILY, weight);
    if (!substituta) return el;
    console.warn(
      `camada "${el.name || "(sem nome)"}": fonte "${family}" peso ${face.weight} é um subset sem os ` +
        `glifos pedidos, usando ${DEFAULT_FONT_FAMILY} peso ${substituta.weight} como substituta`,
    );
    return { ...el, font: DEFAULT_FONT_FAMILY, weight: substituta.weight };
  });
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
