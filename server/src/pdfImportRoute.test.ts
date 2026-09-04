import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp, type AppDeps, type PdfImportDeps, type StorageDeps } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import { FlattenedPdfError, type PdfImportResult, type PdfImportService } from "./pdfImportService.ts";

const KEY = "blk_live_teste";
const OWNER = "owner-1";

function deps(over: Partial<AppDeps> = {}): AppDeps {
  return {
    findApiKeyOwner: async (h) => (h === hashApiKey(KEY) ? { ownerId: OWNER } : null),
    findTemplate: async () => null,
    listTemplates: async () => [],
    createTemplate: async (ownerId, { name, document }) => ({ id: "imported-tpl", ownerId, kind: "custom", name, document }),
    updateTemplate: async () => null,
    deleteTemplate: async () => false,
    listApiKeys: async () => [],
    createApiKey: async (_o, name) => ({ id: "k", name, secret: KEY, createdAt: "2024-01-01T00:00:00.000Z" }),
    revokeApiKey: async () => false,
    deleteApiKey: async () => false,
    renderTemplatePng: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    upsertFontFace: async (input) => ({
      id: input.id, sha256: input.sha256, internalFamily: input.internalFamily,
      postscriptName: input.postscriptName ?? null, weight: input.weight, style: input.style,
      stretch: input.stretch ?? null, os2FsType: input.os2FsType ?? null,
      sfntPath: input.sfntPath, woff2Path: input.woff2Path,
    }),
    listFontFaces: async () => [],
    ...over,
  };
}

/** Só os métodos que storage.ts chama — grava em memória, sem rede. */
function fakeStorage(): StorageDeps {
  const uploaded = new Map<string, Buffer>();
  return {
    client: {
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string, data: Buffer) => {
            uploaded.set(`${bucket}/${path}`, data);
            return { error: null };
          },
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.supabase.co/${bucket}/${path}` } }),
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

function fakePdfImport(result: PdfImportResult | (() => Promise<PdfImportResult>)): PdfImportDeps {
  const service: PdfImportService = {
    importPdf: async () => (typeof result === "function" ? result() : result),
  };
  return { service };
}

const SAMPLE_RESULT: PdfImportResult = {
  pages: [{
    w: 1080,
    h: 1350,
    bg: "#0a1f14",
    elements: [
      { type: "text", x: 10, y: 20, w: 300, h: 60, text: "Título", font: "NYTFranklin", weight: 700, size: 48, fill: "#111111", rot: 0 },
      { type: "image", name: "Foto de fundo", x: 0, y: 0, w: 1080, h: 1350, imageId: "img-1" },
    ],
  }],
  fonts: [{
    familia: "NYTFranklin", estilo: "Bold", peso: 700, glifos: "Título", sha256: "unused-recomputed",
    ttf: Buffer.from("fake-ttf-bytes"), woff2: Buffer.from("fake-woff2-bytes"),
  }],
  images: [{ id: "img-1", contentType: "image/jpeg", bytes: Buffer.from("fake-jpeg-bytes") }],
  flaggedPages: [],
};

function pdfForm(bytes = Buffer.from("%PDF-1.7 conteúdo fake")) {
  const fd = new FormData();
  fd.append("pdf", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), "carrossel.pdf");
  return fd;
}

async function postPdf(app: ReturnType<typeof buildApp>, fd: FormData, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) {
  const req = new Request("http://x/api/v1/imports/pdf", { method: "POST", body: fd });
  return app.inject({
    method: "POST",
    url: "/api/v1/imports/pdf",
    headers: { ...headers, "content-type": req.headers.get("content-type")! },
    payload: Buffer.from(await req.arrayBuffer()),
  });
}

test("responde 501 quando não há storage configurado", async () => {
  const app = buildApp(deps(), null, null, null, fakePdfImport(SAMPLE_RESULT));
  const res = await postPdf(app, pdfForm());
  assert.equal(res.statusCode, 501);
});

test("responde 501 quando o pdf-import-service não está configurado", async () => {
  const app = buildApp(deps(), null, fakeStorage(), null, null);
  const res = await postPdf(app, pdfForm());
  assert.equal(res.statusCode, 501);
});

test("exige autenticação mesmo com tudo configurado", async () => {
  const app = buildApp(deps(), null, fakeStorage(), null, fakePdfImport(SAMPLE_RESULT));
  const res = await postPdf(app, pdfForm(), {});
  assert.equal(res.statusCode, 401);
});

test("recusa um arquivo que não começa com a assinatura %PDF-", async () => {
  const app = buildApp(deps(), null, fakeStorage(), null, fakePdfImport(SAMPLE_RESULT));
  const res = await postPdf(app, pdfForm(Buffer.from("não é um pdf")));
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /não é um PDF/);
});

test("propaga achatado como 422 com o código que o frontend usa para orientar reexportar", async () => {
  const app = buildApp(deps(), null, fakeStorage(), null, fakePdfImport(() => {
    throw new FlattenedPdfError("Este PDF foi exportado achatado.");
  }));
  const res = await postPdf(app, pdfForm());
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().codigo, "achatado");
});

test("responde 502 quando o microsserviço falha por outro motivo", async () => {
  const app = buildApp(deps(), null, fakeStorage(), null, fakePdfImport(() => {
    throw new Error("pdf-import-service respondeu 500");
  }));
  const res = await postPdf(app, pdfForm());
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /respondeu 500/);
});

test("201: monta o Doc a partir do resultado, sobe imagem/fonte e cria o template", async () => {
  let createdDocument: unknown;
  const app = buildApp(
    deps({
      createTemplate: async (ownerId, { name, document }) => {
        createdDocument = document;
        return { id: "imported-tpl", ownerId, kind: "custom", name, document };
      },
    }),
    null,
    fakeStorage(),
    null,
    fakePdfImport(SAMPLE_RESULT),
  );
  const res = await postPdf(app, pdfForm());

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json(), {
    id: "imported-tpl", name: "carrossel", pageCount: 1, layerCount: 2, fontCount: 1, flaggedPages: [],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = createdDocument as any;
  assert.equal(doc.pages.length, 1);
  assert.equal(doc.pages[0].bg, "#0a1f14");
  assert.equal(doc.pages[0].els.length, 2);
  const [text, image] = doc.pages[0].els;
  assert.equal(text.type, "text");
  assert.equal(text.text, "Título");
  assert.equal(text.font, "NYTFranklin");
  assert.equal(image.type, "image");
  assert.equal(image.name, "Foto de fundo");
  assert.match(image.src, /^supabase:\/\/uploads\//);
  assert.equal(doc.fonts.length, 1);
  assert.equal(doc.fonts[0].family, "NYTFranklin");
  assert.match(doc.fonts[0].ttf, /^supabase:\/\/font-sfnt\//);
});
