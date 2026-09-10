import { resolvePageIndex } from "./editableTweetTemplate.ts";
import type { ParsedLayers } from "./layers.ts";

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
    const els = page.els.map((el) => {
      const name = el?.name;
      if (!name) return el;
      if (el.type === "text" && layers.texts[name] !== undefined) {
        if (layers.texts[name] === el.text) return el;
        const { runs: _runs, ...base } = el;
        return { ...base, text: layers.texts[name] };
      }
      if (el.type === "image" && layers.images[name] !== undefined) return { ...el, src: layers.images[name] };
      return el;
    });
    return { ...page, els };
  });

  return { ...doc, pages };
}
