import type { Doc, El } from "./types";

/**
 * Nomes de camada únicos dentro de uma página.
 *
 * O nome de um elemento não é rótulo de UI: é a chave que `POST /api/v1/render` usa em
 * `layers` para dizer QUAL elemento receber cada texto (applyLayerOverrides.ts no servidor
 * percorre a página e sobrescreve todo elemento com aquele nome). Como toda camada de texto
 * nascia chamada "Texto", um design com título e subtítulo expunha dois campos "Texto" no
 * playground e `{"Texto": {...}}` escrevia nos dois — o título saía com o texto do subtítulo.
 *
 * A unicidade é por PÁGINA, não por documento: um carrossel quer o mesmo "Título" em cada
 * slide, e o render sobrescreve só a página que está desenhando.
 */

/** `base`, ou `base 2`, `base 3`… — o primeiro sufixo que ninguém em `taken` está usando. */
export function uniqueLayerName(base: string, taken: Iterable<string>): string {
  const usados = new Set(taken);
  if (!usados.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidato = `${base} ${n}`;
    if (!usados.has(candidato)) return candidato;
  }
}

/**
 * Desfaz duplicatas já salvas, mantendo a PRIMEIRA ocorrência com o nome original: um design
 * antigo continua respondendo ao nome que quem chama a API já conhece, e só as camadas que
 * estavam roubando esse nome mudam. Devolve os nomes que mudaram, para a UI poder avisar.
 */
export function dedupeLayerNames(doc: Doc): { page: number; from: string; to: string }[] {
  const mudancas: { page: number; from: string; to: string }[] = [];
  doc.pages.forEach((page, index) => {
    const usados = new Set<string>();
    for (const el of page.els as El[]) {
      const nome = el.name || "";
      if (!nome) continue;
      if (!usados.has(nome)) { usados.add(nome); continue; }
      const novo = uniqueLayerName(nome, usados);
      el.name = novo;
      usados.add(novo);
      mudancas.push({ page: index, from: nome, to: novo });
    }
  });
  return mudancas;
}
