import type { Doc, El, Page } from "./types";

/**
 * Compara duas versões de um documento e devolve as diferenças campo a campo — pré-requisito
 * de qualquer UI futura de comparação de versão (não existe uma ainda; ver histórico de
 * versões no backlog). Função pura, sem I/O: casamento de página é por `Page.id`, de elemento
 * é por `El.id` — os dois são estáveis entre edições, então uma página/elemento que só mudou de
 * posição na lista continua "o mesmo" para o diff, não vira remove+add.
 */

export interface FieldChange {
  from: unknown;
  to: unknown;
}

export interface ElementDiff {
  elementId: string;
  fields: Record<string, FieldChange>;
}

export interface PageDiff {
  pageId: string;
  fields: Record<string, FieldChange>;
  elementsAdded: El[];
  elementsRemoved: El[];
  elementsChanged: ElementDiff[];
}

export interface DocDiff {
  fields: Record<string, FieldChange>;
  pagesAdded: Page[];
  pagesRemoved: Page[];
  pagesChanged: PageDiff[];
}

/** Compara todo campo presente em `a` OU em `b`, exceto `els`/`pages` (que têm o próprio
 *  diff estruturado) — um campo ausente dos dois lados nunca aparece na saída. */
function diffFields(a: Record<string, unknown>, b: Record<string, unknown>, skip: Set<string>): Record<string, FieldChange> {
  const fields: Record<string, FieldChange> = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (skip.has(key)) continue;
    const from = a[key];
    const to = b[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) fields[key] = { from, to };
  }
  return fields;
}

function diffElements(a: El[], b: El[]): { added: El[]; removed: El[]; changed: ElementDiff[] } {
  const byIdA = new Map(a.map((el) => [el.id, el]));
  const byIdB = new Map(b.map((el) => [el.id, el]));
  const added = b.filter((el) => !byIdA.has(el.id));
  const removed = a.filter((el) => !byIdB.has(el.id));
  const changed: ElementDiff[] = [];
  for (const [id, elA] of byIdA) {
    const elB = byIdB.get(id);
    if (!elB) continue;
    const fields = diffFields(elA, elB, new Set());
    if (Object.keys(fields).length > 0) changed.push({ elementId: id, fields });
  }
  return { added, removed, changed };
}

export function diffDocs(a: Doc, b: Doc): DocDiff {
  const byIdA = new Map(a.pages.map((p) => [p.id, p]));
  const byIdB = new Map(b.pages.map((p) => [p.id, p]));
  const pagesAdded = b.pages.filter((p) => !byIdA.has(p.id));
  const pagesRemoved = a.pages.filter((p) => !byIdB.has(p.id));
  const pagesChanged: PageDiff[] = [];
  for (const [id, pageA] of byIdA) {
    const pageB = byIdB.get(id);
    if (!pageB) continue;
    const fields = diffFields(pageA as unknown as Record<string, unknown>, pageB as unknown as Record<string, unknown>, new Set(["els"]));
    const { added, removed, changed } = diffElements(pageA.els, pageB.els);
    if (Object.keys(fields).length > 0 || added.length > 0 || removed.length > 0 || changed.length > 0) {
      pagesChanged.push({ pageId: id, fields, elementsAdded: added, elementsRemoved: removed, elementsChanged: changed });
    }
  }
  return {
    fields: diffFields(a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>, new Set(["pages"])),
    pagesAdded,
    pagesRemoved,
    pagesChanged,
  };
}

/** Verdadeiro quando as duas versões não têm nenhuma diferença — atalho pra não montar um
 *  `DocDiff` inteiro só pra descobrir que está tudo igual. */
export function docsAreEqual(a: Doc, b: Doc): boolean {
  const diff = diffDocs(a, b);
  return (
    Object.keys(diff.fields).length === 0 &&
    diff.pagesAdded.length === 0 &&
    diff.pagesRemoved.length === 0 &&
    diff.pagesChanged.length === 0
  );
}
