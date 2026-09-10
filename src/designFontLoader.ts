import type { Doc, DocFont } from "./types";

/**
 * Registra no navegador as fontes que um design carrega consigo (`Doc.fonts`).
 *
 * Um design importado de PDF usa famílias que não estão em lugar nenhum — nem no Google Fonts
 * que o index.html carrega, nem instaladas na máquina de quem abre. Sem isto o canvas desenha
 * a manchete numa fonte de fallback mais larga, e os trechos, que são posicionados pela
 * largura medida do trecho anterior, colidem entre si.
 *
 * Usa a FontFace API em vez de injetar @font-face num <style>: as fontes vêm do documento, que
 * muda a cada design aberto, e aqui dá para esperar o carregamento antes de redesenhar. É o
 * que evita o canvas pintar uma vez com o fallback e "pular" quando a fonte chega.
 */

/** Família+peso já registrados neste documento — abrir o mesmo design duas vezes não recarrega. */
const loaded = new Set<string>();

function key(font: DocFont): string {
  return `${font.family}::${font.weight}::${font.sha256}`;
}

async function loadOne(font: DocFont): Promise<void> {
  if (!font.family || !font.woff2 || loaded.has(key(font))) return;
  try {
    const face = new FontFace(font.family, `url(${font.woff2}) format("woff2")`, {
      weight: String(font.weight || 400),
    });
    await face.load();
    document.fonts.add(face);
    loaded.add(key(font));
  } catch {
    // Fonte inacessível: o design ainda abre, só desenha com a fonte de fallback.
  }
}

/** Resolve quando todas as faces do documento terminaram (ou falharam). */
export async function loadDesignFonts(doc: Doc): Promise<void> {
  if (!doc.fonts?.length) return;
  // Keep subset precedence identical to the API's ordered @font-face declarations.
  for (const font of doc.fonts) await loadOne(font);
}

/**
 * Um subset vindo de PDF traz só os glifos que a arte original usava. Isto diz quais
 * caracteres de um texto aquela face NÃO consegue desenhar, para a UI poder avisar em vez de
 * deixar a pessoa digitando e vendo nada aparecer.
 */
export function missingGlyphs(doc: Doc, family: string, weight: number, text: string): string[] {
  const font = doc.fonts?.find((f) => f.family === family && f.weight === weight);
  if (!font?.glyphs) return [];
  const have = new Set([...font.glyphs]);
  return [...new Set([...text])].filter((ch) => !have.has(ch));
}
