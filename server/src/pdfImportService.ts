/**
 * Cliente do `pdf-import-service` (microsserviço separado, próprio Docker) — quem fala HTTP com
 * ele é só este arquivo, para a rota em app.ts poder ser testada sem rede de verdade (mesmo
 * padrão de injeção de `fetchJson` usado em mediaAcquisition.ts).
 */

export type ImportedTextElement = {
  type: "text";
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  font: string;
  weight: number;
  size: number;
  fill: string;
  rot: number;
};

export type ImportedImageElement = {
  type: "image";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  imageId: string;
};

export type ImportedElement = ImportedTextElement | ImportedImageElement;

export interface ImportedPage {
  w: number;
  h: number;
  /** Cor de fundo real da página, lida do PDF pelo microsserviço (ver pdf-import-service/
   *  scripts/canva-pdf-fonts.py `detectar_fundo`) — "#ffffff" quando o PDF não tinha um
   *  preenchimento cobrindo a página inteira. */
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

export interface ImportedImage {
  id: string;
  contentType: "image/png" | "image/jpeg";
  bytes: Buffer;
}

export interface PdfImportResult {
  pages: ImportedPage[];
  fonts: ImportedFont[];
  images: ImportedImage[];
  flaggedPages: number[];
}

/** Todas as páginas do PDF vieram achatadas (uma imagem por página, sem texto nem camadas) —
 *  o microsserviço já checou isso; aqui só se propaga como um tipo de erro distinto, porque a
 *  rota em app.ts responde 422 com uma orientação diferente de qualquer outra falha. */
export class FlattenedPdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlattenedPdfError";
  }
}

export interface PdfImportService {
  importPdf(bytes: Buffer): Promise<PdfImportResult>;
}

export interface PdfImportServiceConfig {
  serviceUrl: string;
  secret?: string;
}

type JsonFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface RawPdfImportResponse {
  erro?: string;
  codigo?: string;
  pages?: ImportedPage[];
  fonts?: Array<{
    familia: string;
    estilo: string;
    peso: number;
    glifos: string;
    sha256: string;
    postscriptName?: string;
    ttfBase64: string;
    woff2Base64: string;
  }>;
  images?: Array<{ id: string; contentType: "image/png" | "image/jpeg"; bytesBase64: string }>;
  flaggedPages?: number[];
}

export function createHttpPdfImportService(
  config: PdfImportServiceConfig,
  deps: { fetchJson?: JsonFetch } = {},
): PdfImportService {
  const fetchJson = deps.fetchJson ?? fetch;
  const baseUrl = config.serviceUrl.replace(/\/$/, "");

  return {
    async importPdf(bytes) {
      const form = new FormData();
      form.append("pdf", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), "import.pdf");
      const response = await fetchJson(`${baseUrl}/importar`, {
        method: "POST",
        headers: config.secret ? { "X-Import-Secret": config.secret } : undefined,
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await response.json()) as RawPdfImportResponse;
      if (!response.ok) {
        if (response.status === 422 && body.codigo === "achatado") {
          throw new FlattenedPdfError(body.erro ?? "Este PDF foi exportado achatado.");
        }
        throw new Error(body.erro ?? `pdf-import-service respondeu ${response.status}`);
      }
      return {
        pages: body.pages ?? [],
        fonts: (body.fonts ?? []).map((f) => ({
          familia: f.familia,
          estilo: f.estilo,
          peso: f.peso,
          glifos: f.glifos,
          sha256: f.sha256,
          postscriptName: f.postscriptName,
          ttf: Buffer.from(f.ttfBase64, "base64"),
          woff2: Buffer.from(f.woff2Base64, "base64"),
        })),
        images: (body.images ?? []).map((i) => ({
          id: i.id,
          contentType: i.contentType,
          bytes: Buffer.from(i.bytesBase64, "base64"),
        })),
        flaggedPages: body.flaggedPages ?? [],
      };
    },
  };
}
