import { resolvePageIndex } from "./editableTweetTemplate.ts";
import type { ParsedLayers } from "./layers.ts";
import { replaceTemplateText } from "./replacementFonts.ts";
import { canonicalLayerNames } from "./layerNames.ts";

interface OverridableElement {
  name?: string;
  type?: string;
  text?: string;
  src?: string;
  [key: string]: unknown;
}

interface OverridablePage {
  els?: OverridableElement[];
  [key: string]: unknown;
}

interface OverridableDocument {
  fonts?: Array<{ family: string; glyphs?: string; subset?: boolean; style?: string }>;
  pages?: OverridablePage[];
  [key: string]: unknown;
}

/**
 * O que faz `save:true` em `POST /api/v1/render` (server/src/app.ts) virar "gravar no próprio
 * template": sobrescreve só o `text`/`src` dos elementos NOMEADOS na página que foi de fato
 * renderizada — todo o resto (outras páginas, elementos sem nome, posição/estilo/layout) sai
 * bit a bit igual ao que já estava salvo. Por isso um carrossel gerado com três chamadas
 * (`page:1`, `page:2`, `page:3`, cada uma `save:true`) vira um documento de três páginas só,
 * sem uma chamada apagar o que a anterior gravou nas outras páginas.
 *
 * Também é aqui que os nomes da página viram os nomes que a API expõe: um template salvo
 * antes de o editor garantir unicidade tem duas camadas "Texto", e `layers` não conseguiria
 * endereçar a segunda — o override entrava nas duas. `canonicalLayerNames` dá à segunda o
 * nome "Texto 2", derivado da ordem dos elementos, e o mesmo cálculo roda no formulário do
 * playground. Assim um template antigo fica endereçável sem ninguém reabrir e salvar o design,
 * e o nome original continua valendo para a primeira camada, que é quem já era atingida.
 *
 * `hidden` do request nunca é persistido aqui: é um efeito só daquela renderização (o desenho
 * pula o elemento), não uma mudança estrutural do design salvo — esconder um elemento numa
 * geração não deveria fazer ele sumir do template permanentemente.
 */
export function applyLayerOverrides(document: unknown, layers: ParsedLayers, pageIndex: number | undefined): unknown {
  const doc = document as OverridableDocument;
  if (!Array.isArray(doc.pages)) return document;

  const resolvedIndex = resolvePageIndex(document, pageIndex);
  if (resolvedIndex === null) return document;

  const pages = doc.pages.map((page, index) => {
    if (index !== resolvedIndex || !Array.isArray(page.els)) return page;
    const nomes = canonicalLayerNames(page);
    const els = page.els.map((el, i) => {
      const name = nomes[i];
      if (!name) return el;
      // O nome canônico acompanha o elemento daqui pra frente: o SVG, as imagens e o
      // `save:true` leem `el.name`, e todos devem ver o mesmo nome que o override usou.
      const nomeado = el.name === name ? el : { ...el, name };
      if (nomeado.type === "text" && layers.texts[name] !== undefined) {
        return replaceTemplateText(nomeado, layers.texts[name], doc.fonts);
      }
      if (nomeado.type === "image" && layers.images[name] !== undefined) return { ...nomeado, src: layers.images[name] };
      return nomeado;
    });
    return { ...page, els };
  });

  return { ...doc, pages };
}
