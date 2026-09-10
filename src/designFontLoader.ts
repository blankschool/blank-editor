import type { Doc, DocFont } from "./types";
import { replacementFontFiles, REPLACEMENT_PREFIX } from "../server/src/render/replacementFonts.ts";

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
  return `${font.family}::${font.weight}::${font.style || "normal"}::${font.sha256}`;
}

async function loadOne(font: DocFont): Promise<void> {
  if (!font.family || !font.woff2 || loaded.has(key(font))) return;
  try {
    const face = new FontFace(font.family, `url(${JSON.stringify(font.woff2)})`, {
      weight: String(font.weight || 400),
      style: /italic|oblique/i.test(font.style || "") ? "italic" : "normal",
    });
    await face.load();
    document.fonts.add(face);
    loaded.add(key(font));
  } catch (error) {
    throw new Error(`Nao foi possivel carregar a fonte ${font.family}.`, { cause: error });
  }
}

/** Resolve quando todas as faces do documento terminaram (ou falharam). */
export async function loadDesignFonts(doc: Doc): Promise<void> {
  const needed = new Set(doc.pages.flatMap(p => p.els.filter(e => e.type === "text" && e.font?.startsWith(REPLACEMENT_PREFIX)).map(e => e.font)));
  await Promise.all(replacementFontFiles.filter(f => needed.has(f.family)).map(async f => {
    const id = `${f.family}::${f.weight}::${f.style}`;
    if (loaded.has(id)) return;
    const face = new FontFace(f.family, `url(/api/v1/render-fonts/${f.file}) format("truetype")`, { weight: String(f.weight), style: f.style });
    await face.load();
    document.fonts.add(face);
    loaded.add(id);
  }));
  // Keep subset precedence identical to the API's ordered @font-face declarations.
  for (const font of doc.fonts ?? []) await loadOne(font);
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
