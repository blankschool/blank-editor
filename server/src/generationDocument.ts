import { randomUUID } from "node:crypto";
import type { Layers } from "./render/layers.ts";

interface GeneratedElement {
  id?: string;
  type?: string;
  name?: string;
  text?: string;
  src?: string;
  hidden?: boolean;
  [key: string]: unknown;
}

interface GeneratedPage {
  id?: string;
  els?: GeneratedElement[];
  [key: string]: unknown;
}

export interface GeneratedDocument {
  name: string;
  active: number;
  pages: GeneratedPage[];
  [key: string]: unknown;
}

export interface GenerationPageInput {
  layers: Layers;
}

export class GenerationDocumentError extends Error {}

/**
 * Creates the document persisted for an automated generation. A one-page model
 * is a reusable card and is copied once per requested output page.
 */
export function buildGeneratedDocument(
  source: unknown,
  name: string,
  requestedPages: readonly GenerationPageInput[],
): GeneratedDocument {
  if (!source || typeof source !== "object") throw new GenerationDocumentError("template must be a document object");
  const sourceDocument = structuredClone(source) as GeneratedDocument;
  const sourcePages = Array.isArray(sourceDocument.pages) ? sourceDocument.pages : [];
  if (sourcePages.length === 0) throw new GenerationDocumentError("template must contain at least one page");
  if (sourcePages.length > 1 && requestedPages.length !== sourcePages.length) {
    throw new GenerationDocumentError(`generated page count must match the template page count of ${sourcePages.length}`);
  }
  const pages = requestedPages.map((requested, index) => {
    const sourcePage = sourcePages.length === 1 ? sourcePages[0] : sourcePages[index];
    const page = structuredClone(sourcePage) as GeneratedPage;
    const namedElements = new Map((page.els ?? []).filter((element) => element.name).map((element) => [element.name!, element]));
    for (const [layerName, override] of Object.entries(requested.layers)) {
      const element = namedElements.get(layerName);
      if (!element) {
        throw new GenerationDocumentError(`page ${index + 1} has unknown layer: ${layerName}`);
      }
      if (override.text !== undefined && element.type !== "text") {
        throw new GenerationDocumentError(`page ${index + 1} layer ${layerName} does not accept text`);
      }
      if (override.image_url !== undefined && element.type !== "image") {
        throw new GenerationDocumentError(`page ${index + 1} layer ${layerName} does not accept image_url`);
      }
    }
    page.id = randomUUID();
    page.els = (page.els ?? []).map((element) => {
      const override = element.name ? requested.layers[element.name] : undefined;
      if (!override) return element;
      let generated = element;
      if (element.type === "text" && override.text !== undefined) generated = { ...generated, text: override.text };
      if (element.type === "image" && override.image_url !== undefined) generated = { ...generated, src: override.image_url };
      if (override.hide !== undefined) generated = { ...generated, hidden: override.hide };
      return generated;
    });
    return page;
  });

  return { ...sourceDocument, name, active: 0, pages };
}
