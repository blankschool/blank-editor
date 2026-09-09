import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { FlattenedPdfError, importCanvaPdf } from "./orchestrate.ts";

const IMPORT_SECRET = process.env.IMPORT_SECRET;

export function buildApp() {
  const app = Fastify({ logger: true, bodyLimit: 60 * 1024 * 1024 });
  app.register(multipart, { limits: { fileSize: 60 * 1024 * 1024 } });

  app.get("/saude", async () => ({ ok: true }));

  app.post("/importar", async (request, reply) => {
    if (IMPORT_SECRET && request.headers["x-import-secret"] !== IMPORT_SECRET) {
      reply.status(401);
      return { erro: "X-Import-Secret ausente ou inválido" };
    }

    const file = await request.file();
    if (!file || file.fieldname !== "pdf") {
      reply.status(400);
      return { erro: "envie o campo 'pdf' como multipart" };
    }
    const bytes = await file.toBuffer();
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      reply.status(400);
      return { erro: "arquivo não é um PDF" };
    }

    try {
      const result = await importCanvaPdf(bytes);
      return {
        // `previewPng` é Buffer — a serialização default do Fastify pra Buffer é
        // {type:"Buffer",data:[...]}, que o cliente não espera. Mesmo padrão de base64 já usado
        // abaixo pra fonte/imagem.
        pages: result.pages.map((p) => ({
          w: p.w, h: p.h, bg: p.bg, elements: p.elements,
          ...(p.previewPng ? { previewPngBase64: p.previewPng.toString("base64") } : {}),
        })),
        fonts: result.fonts.map((f) => ({
          familia: f.familia,
          estilo: f.estilo,
          peso: f.peso,
          glifos: f.glifos,
          sha256: f.sha256,
          postscriptName: f.postscriptName,
          ttfBase64: f.ttf.toString("base64"),
          woff2Base64: f.woff2.toString("base64"),
        })),
        images: result.images.map((i) => ({
          id: i.id,
          contentType: i.contentType,
          bytesBase64: i.bytes.toString("base64"),
        })),
        flaggedPages: result.flaggedPages,
      };
    } catch (error) {
      if (error instanceof FlattenedPdfError) {
        reply.status(422);
        return { erro: error.message, codigo: "achatado" };
      }
      app.log.error(error);
      reply.status(500);
      return { erro: error instanceof Error ? error.message.slice(0, 500) : "falha ao importar" };
    }
  });

  return app;
}
