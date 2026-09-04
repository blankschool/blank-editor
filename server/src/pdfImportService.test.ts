import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpPdfImportService, FlattenedPdfError } from "./pdfImportService.ts";

test("importPdf posts multipart to /importar with the shared secret and decodes base64 payloads", async () => {
  let requestUrl = "";
  let secretHeader: string | null = null;
  let sentPdf: Buffer | null = null;
  const service = createHttpPdfImportService({ serviceUrl: "http://pdf-import:8791/", secret: "top-secret" }, {
    fetchJson: async (url, init) => {
      requestUrl = url;
      secretHeader = new Headers(init?.headers).get("X-Import-Secret");
      const form = init?.body as FormData;
      const file = form.get("pdf") as File;
      sentPdf = Buffer.from(await file.arrayBuffer());
      return new Response(JSON.stringify({
        pages: [{ w: 1080, h: 1350, bg: "#123456", elements: [{ type: "text", x: 0, y: 0, w: 100, h: 20, text: "Oi", font: "Inter", weight: 400, size: 16, fill: "#000000", rot: 0 }] }],
        fonts: [{
          familia: "Inter", estilo: "Regular", peso: 400, glifos: "abc", sha256: "deadbeef",
          ttfBase64: Buffer.from("ttf-bytes").toString("base64"),
          woff2Base64: Buffer.from("woff2-bytes").toString("base64"),
        }],
        images: [{ id: "img-1", contentType: "image/png", bytesBase64: Buffer.from("png-bytes").toString("base64") }],
        flaggedPages: [],
      }), { status: 200 });
    },
  });

  const result = await service.importPdf(Buffer.from("%PDF-1.7 fake"));

  assert.equal(requestUrl, "http://pdf-import:8791/importar");
  assert.equal(secretHeader, "top-secret");
  assert.equal(sentPdf!.toString(), "%PDF-1.7 fake");
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].bg, "#123456");
  assert.equal(result.fonts[0].ttf.toString(), "ttf-bytes");
  assert.equal(result.fonts[0].woff2.toString(), "woff2-bytes");
  assert.equal(result.images[0].bytes.toString(), "png-bytes");
});

test("importPdf throws FlattenedPdfError on a 422 achatado response", async () => {
  const service = createHttpPdfImportService({ serviceUrl: "http://pdf-import:8791" }, {
    fetchJson: async () => new Response(JSON.stringify({ erro: "achatado demais", codigo: "achatado" }), { status: 422 }),
  });
  await assert.rejects(() => service.importPdf(Buffer.from("x")), FlattenedPdfError);
});

test("importPdf throws a plain error on any other failure response", async () => {
  const service = createHttpPdfImportService({ serviceUrl: "http://pdf-import:8791" }, {
    fetchJson: async () => new Response(JSON.stringify({ erro: "algo quebrou" }), { status: 500 }),
  });
  await assert.rejects(() => service.importPdf(Buffer.from("x")), /algo quebrou/);
});
