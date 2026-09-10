import type { Doc } from './types.ts';
import { createTemplateOnServer } from './templateStore.ts';
import { replaceTemplateText } from '../server/src/render/replacementFonts.ts';

export interface PlaygroundField {
  name: string;
  type: 'text' | 'image';
  value: string;
}

/** Keep an editable snapshot of exactly the values sent to render, not its flattened PNG.
 * Blank fields are omitted by the Playground request, so they keep the template defaults. */
export function createPlaygroundDocument(source: Doc, page: number, fields: readonly PlaygroundField[]): Doc {
  if (!Number.isInteger(page) || page < 1 || page > source.pages.length) {
    throw new Error('Página do template indisponível. Selecione o template novamente.');
  }
  const document = structuredClone(source);
  delete document.seedId;
  document.name = `${source.name} — edição`;
  document.active = page - 1;
  for (const field of fields) {
    if (!field.value.trim()) continue;
    for (const element of document.pages[document.active].els) {
      if (element.name !== field.name || element.type !== field.type) continue;
      if (element.type === 'text') {
        const replacement = replaceTemplateText(element, field.value, document.fonts);
        if (replacement !== element) {
          delete element.runs;
          Object.assign(element, replacement);
        }
      }
      else element.src = field.value.trim();
    }
  }
  return document;
}

/** Save first so the editor's normal routing, refresh and autosave all target the copy. */
export async function savePlaygroundCopy(document: Doc): Promise<Doc> {
  const copy = structuredClone(document);
  delete copy.seedId;
  const id = await createTemplateOnServer(copy.name, copy);
  return { ...copy, seedId: id };
}
