import type { Doc } from './types.ts';

export interface GerarFixedVisibility {
  id: string;
  hidden: boolean;
}

export interface GerarFixedElement extends GerarFixedVisibility {
  name: string;
  type: string;
}

export function isBlankGerarImageSource(src: unknown): boolean {
  if (typeof src !== 'string' || !src) return false;
  try {
    return new URL(src).hostname.toLowerCase() === 'placehold.co';
  } catch {
    return false;
  }
}

/**
 * A geração starts from a copy of the selected design. Older Blank starters used
 * placehold.co URLs for empty image slots; those are editor affordances, not user
 * content, so they must not appear in a generated post. The image element stays
 * in the document and can still receive an upload/URL in Gerar or in the editor.
 */
export function prepareGerarDraftDocument(
  source: Doc,
  page = 0,
  fixedVisibility: readonly GerarFixedVisibility[] = [],
): Doc {
  const document = structuredClone(source);
  for (const page of document.pages) {
    for (const element of page.els) {
      if (element.type === 'image' && isBlankGerarImageSource(element.src)) element.src = '';
    }
  }
  const fixed = new Map(fixedVisibility.map(element => [element.id, element.hidden]));
  for (const element of document.pages[page]?.els ?? []) {
    if (fixed.has(element.id)) element.hidden = fixed.get(element.id)!;
  }
  return document;
}

export function hasBlankGerarImageSource(source: Doc): boolean {
  return source.pages.some(page => page.els.some(
    element => element.type === 'image' && isBlankGerarImageSource(element.src),
  ));
}

/** Dynamic named text/image elements get form fields; everything else is authored decoration. */
export function listGerarFixedElements(source: Doc, page: number): GerarFixedElement[] {
  return (source.pages[page]?.els ?? [])
    .filter(element => !(element.name && (element.type === 'text' || element.type === 'image')))
    .map(element => ({
      id: element.id,
      name: element.name || 'Elemento sem nome',
      type: element.type,
      hidden: Boolean(element.hidden),
    }));
}
