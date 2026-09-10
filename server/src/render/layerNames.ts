
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
interface NamedElement { name?: string }
interface NamedPage { els?: NamedElement[] }

/**
 * Os nomes que a API enxerga numa página, na ordem dos elementos: o primeiro "Texto" continua
 * "Texto", o segundo vira "Texto 2". Derivar isto dos dois lados — o formulário que lista os
 * campos e o render que aplica os overrides — é o que faz um template ANTIGO, salvo com nomes
 * repetidos, virar endereçável sem ninguém precisar reabrir e salvar o design.
 */
export function canonicalLayerNames(page: NamedPage | null | undefined): string[] {
  const usados = new Set<string>();
  return (page?.els ?? []).map((el) => {
    const nome = el?.name || "";
    if (!nome) return nome;
    const unico = uniqueLayerName(nome, usados);
    usados.add(unico);
    return unico;
  });
}

export function dedupeLayerNames(doc: { pages: NamedPage[] }): { page: number; from: string; to: string }[] {
  const mudancas: { page: number; from: string; to: string }[] = [];
  doc.pages.forEach((page, index) => {
    const usados = new Set<string>();
    for (const el of page.els ?? []) {
      const nome = el?.name || "";
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
