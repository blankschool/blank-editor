/**
 * Junta as duas metades do pipeline (imagens via poppler-utils+sharp, fontes+texto via
 * PyMuPDF+fontTools) numa função pura PDF → dados estruturados.
 *
 * De propósito, isto NÃO fala com storage nem banco nenhum — devolve tudo (imagens e fontes em
 * base64, texto já posicionado) pro chamador (o server principal do Blank Editor) persistir com
 * a identidade/credencial de quem pediu a importação. Mesma separação usada no pipeline do n8n
 * nesta mesma sessão: o serviço externo só transforma, o dono dos dados grava.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { countPdfPages, extractPageImages, type ExtractedImageElement } from "./extractImages.ts";
import { extractFontsAndText, type ExtractedPageElement } from "./pythonExtract.ts";
import { isFlattenedPage } from "./flatDetection.ts";

export class FlattenedPdfError extends Error {
  constructor() {
    super("Este PDF foi exportado achatado: cada página é uma imagem única, sem texto nem camadas.");
    this.name = "FlattenedPdfError";
  }
}

export interface ImportedImage {
  id: string;
  contentType: "image/png" | "image/jpeg";
  bytes: Buffer;
}

export type ImportedElement =
  | (ExtractedPageElement & { name?: string })
  | { type: "image"; name: string; x: number; y: number; w: number; h: number; imageId: string };

export interface ImportedPage {
  w: number;
  h: number;
  /** Cor de fundo real da página, lida do preenchimento vetorial que cobre a página
   *  inteira no PDF. "#ffffff" quando o PDF não tinha nenhum (ex.: fundo é uma foto que
   *  cobre tudo, ou o design realmente não pinta nada por trás). */
  bg: string;
  elements: ImportedElement[];
}

export interface ImportedFont {
  familia: string;
  estilo: string;
  peso: number;
  glifos: string;
  sha256: string;
  postscriptName?: string;
  ttf: Buffer;
  woff2: Buffer;
}

export interface ImportResult {
  pages: ImportedPage[];
  fonts: ImportedFont[];
  images: ImportedImage[];
  flaggedPages: number[];
}

const TARGET_WIDTH_PX = 1080;

export async function importCanvaPdf(pdfBytes: Buffer): Promise<ImportResult> {
  const workDir = await mkdtemp(join(tmpdir(), "canva-pdf-"));
  try {
    const pdfPath = resolve(workDir, "input.pdf");
    await writeFile(pdfPath, pdfBytes);

    const pageCount = await countPdfPages(pdfPath);
    if (pageCount < 1) throw new Error("PDF sem páginas");

    const [{ fonts, elementsByPage, bgByPage }, ...imagePages] = await Promise.all([
      extractFontsAndText(pdfPath, resolve(workDir, "fonts")),
      ...Array.from({ length: pageCount }, (_, i) =>
        extractPageImages(pdfPath, i + 1, resolve(workDir, `page-${i + 1}`), TARGET_WIDTH_PX)),
    ]);

    const images: ImportedImage[] = [];
    const pages: ImportedPage[] = [];
    const flaggedPages: number[] = [];

    imagePages.forEach((imageResult, index) => {
      const pageNumber = index + 1;
      const pageElements = elementsByPage.get(pageNumber) ?? [];
      // Formas atrás de tudo, texto na frente — a única ordem que dá pra afirmar sem
      // ambiguidade: formas e texto vêm do mesmo passo em Python (nessa ordem relativa,
      // já correta), mas imagem vem de um passo totalmente separado (poppler-utils), sem
      // informação de ordem de pintura entre as duas fontes de extração.
      const shapeElements = pageElements.filter((el) => el.type === "rect");
      const textElements = pageElements.filter((el) => el.type === "text");
      const imageElements: ImportedElement[] = imageResult.elements.map((el: ExtractedImageElement) => {
        const id = randomUUID();
        images.push({ id, contentType: el.contentType, bytes: el.bytes });
        return { type: "image", name: el.name, x: el.x, y: el.y, w: el.w, h: el.h, imageId: id };
      });
      const elements = [...shapeElements, ...imageElements, ...textElements];

      if (isFlattenedPage(
        // Formas não contam pra detecção de achatado — só "tem texto de verdade?" e "tem uma
        // única imagem cobrindo tudo?" importam aqui.
        [...imageElements, ...textElements].map((el) =>
          ("imageId" in el ? { type: "image" as const, w: el.w, h: el.h } : { type: "text" as const, w: el.w, h: el.h })),
        imageResult.canvas,
      )) {
        flaggedPages.push(pageNumber);
      }

      pages.push({ w: imageResult.canvas.w, h: imageResult.canvas.h, bg: bgByPage.get(pageNumber) ?? "#ffffff", elements });
    });

    if (flaggedPages.length === pages.length) throw new FlattenedPdfError();

    return {
      pages,
      fonts: fonts.map((f) => ({
        familia: f.familia,
        estilo: f.estilo,
        peso: f.peso,
        glifos: f.glifos,
        sha256: f.sha256,
        postscriptName: f.postscriptName,
        ttf: f.ttf,
        woff2: f.woff2,
      })),
      images,
      flaggedPages,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
