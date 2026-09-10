import { randomUUID } from "node:crypto";
import type { Layers } from "./render/layers.ts";
import type { MediaAssetRequest } from "./mediaAcquisition.ts";
import { replaceTemplateText } from "./render/replacementFonts.ts";

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
  fonts?: Array<{ family: string; glyphs?: string; subset?: boolean; style?: string }>;
  name: string;
  active: number;
  pages: GeneratedPage[];
  [key: string]: unknown;
}

export interface GenerationPageInput {
  layers: Record<string, Layers[string] & { asset?: MediaAssetRequest }>;
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
      if (override.text !== undefined && typeof override.text !== "string") {
        throw new GenerationDocumentError(`page ${index + 1} layer ${layerName}.text must be a string`);
      }
      if (override.image_url !== undefined && typeof override.image_url !== "string") {
        throw new GenerationDocumentError(`page ${index + 1} layer ${layerName}.image_url must be a string`);
      }
      if (override.hide !== undefined && typeof override.hide !== "boolean") {
        throw new GenerationDocumentError(`page ${index + 1} layer ${layerName}.hide must be a boolean`);
      }
      if (override.text !== undefined && element.type !== "text") {
        throw new GenerationDocumentError(`page ${index + 1} layer ${layerName} does not accept text`);
      }
      if (override.image_url !== undefined && element.type !== "image") {
        throw new GenerationDocumentError(`page ${index + 1} layer ${layerName} does not accept image_url`);
      }
      if (override.asset !== undefined && element.type !== "image") {
        throw new GenerationDocumentError(`page ${index + 1} layer ${layerName} does not accept asset`);
      }
    }
    page.id = randomUUID();
    page.els = (page.els ?? []).map((element) => {
      const override = element.name ? requested.layers[element.name] : undefined;
      if (!override) return element;
      let generated = element;
      if (element.type === "text" && override.text !== undefined) generated = replaceTemplateText(generated, override.text, sourceDocument.fonts);
      if (element.type === "image" && override.image_url !== undefined) generated = { ...generated, src: override.image_url };
      if (override.hide !== undefined) generated = { ...generated, hidden: override.hide };
      return generated;
    });
    return page;
  });

  return { ...sourceDocument, name, active: 0, pages };
}
