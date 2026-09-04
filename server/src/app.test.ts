import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp, type AppDeps } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import type { TemplateRow } from "./db.ts";
import { createMemoryGenerationRepository } from "./generationWorkflow.ts";

const VALID_KEY = "blk_live_test";
const OWNER_ID = "owner-1";
const AUTH = { authorization: `Bearer ${VALID_KEY}` };
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // just needs to be *a* buffer for these tests

const TPL: TemplateRow = {
  id: "tpl-1",
  ownerId: OWNER_ID,
  kind: "tweet",
  name: "Tweet",
  favorite: false,
  document: { active: 0, pages: [{ w: 566, h: 120, bg: "#000", els: [] }] },
};

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    findApiKeyOwner: async (keyHash) => (keyHash === hashApiKey(VALID_KEY) ? { ownerId: OWNER_ID } : null),
    findTemplate: async (ownerId, id) => (id === TPL.id && ownerId === TPL.ownerId ? TPL : null),
    listTemplates: async (ownerId) =>
      ownerId === OWNER_ID ? [{ id: TPL.id, name: TPL.name, updatedAt: "2024-01-01T00:00:00.000Z", favorite: TPL.favorite }] : [],
    createTemplate: async (ownerId, { name, document }) => ({ id: "new-tpl", ownerId, kind: "custom", name, document, favorite: false }),
    updateTemplate: async (ownerId, id, input) => (id === TPL.id && ownerId === TPL.ownerId ? { ...TPL, ...input } : null),
    deleteTemplate: async (ownerId, id) => id === TPL.id && ownerId === TPL.ownerId,
    listApiKeys: async (ownerId) =>
      ownerId === OWNER_ID ? [{ id: "key-1", name: "prod", createdAt: "2024-01-01T00:00:00.000Z", revoked: false }] : [],
    createApiKey: async (ownerId, name) => ({ id: "new-key", name, secret: "blk_live_generated", createdAt: "2024-01-01T00:00:00.000Z" }),
    revokeApiKey: async (ownerId, id) => id === "key-1" && ownerId === OWNER_ID,
    deleteApiKey: async (ownerId, id) => id === "revoked-key" && ownerId === OWNER_ID,
    renderTemplatePng: async () => PNG_BYTES,
    upsertFontFace: async (input) => ({
      id: input.id, sha256: input.sha256, internalFamily: input.internalFamily,
      postscriptName: input.postscriptName ?? null, weight: input.weight, style: input.style,
      stretch: input.stretch ?? null, os2FsType: input.os2FsType ?? null,
      sfntPath: input.sfntPath, woff2Path: input.woff2Path,
    }),
    listFontFaces: async () => [],
    ...overrides,
  };
}

const validBody = {
  template: TPL.id,
  layers: {
    avatar: { image_url: "https://example.com/a.jpg" },
    displayName: { text: "Micael Crasto" },
  },
};

test("reports that the local API process is healthy", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});


const CARROSSEL: TemplateRow = {
  id: "tpl-carrossel",
  ownerId: OWNER_ID,
  kind: "custom",
  name: "Carrossel",
  favorite: false,
  document: {
    active: 0,
    pages: [
      { w: 1080, h: 1350, bg: "#000", els: [] },
      { w: 1080, h: 1350, bg: "#111", els: [] },
      { w: 1080, h: 1350, bg: "#222", els: [] },
    ],
  },
};

/** deps que também conhecem o carrossel e registram com que página o render foi chamado. */
function makeMultiPageDeps() {
  const calls: Array<number | undefined> = [];
  const deps = makeDeps({
    findTemplate: async (ownerId, id) =>
      ownerId !== OWNER_ID ? null : id === TPL.id ? TPL : id === CARROSSEL.id ? CARROSSEL : null,
    renderTemplatePng: async (_document, _layers, pageIndex) => {
      calls.push(pageIndex);
      return PNG_BYTES;
    },
  });
  return { deps, calls };
}

// --- POST /api/v1/render ----------------------------------------------------

test("rejects a render request with no Authorization header", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({ method: "POST", url: "/api/v1/render", payload: validBody });
  assert.equal(res.statusCode, 401);
});

test("rejects a render request with an unknown API key", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: { authorization: "Bearer wrong-key" },
    payload: validBody,
  });
  assert.equal(res.statusCode, 401);
});

test("404s when the template id does not exist", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: AUTH,
    payload: { ...validBody, template: "does-not-exist" },
  });
  assert.equal(res.statusCode, 404);
});

test("404s when the template belongs to a different owner", async () => {
  // Simula o que a query real faz: `where id = ... and owner_id = ...` não devolve linha
  // nenhuma quando o dono não bate, mesmo que o id exista pra outro dono.
  const app = buildApp(makeDeps({ findTemplate: async () => null }));
  const res = await app.inject({ method: "POST", url: "/api/v1/render", headers: AUTH, payload: validBody });
  assert.equal(res.statusCode, 404);
});

test("returns a PNG image on a valid authenticated request", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: AUTH,
    payload: validBody,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/png");
  assert.deepEqual(res.rawPayload, PNG_BYTES);
});

test("renders using the template's own stored document and the request's parsed layers", async () => {
  let received: unknown;
  const app = buildApp(
    makeDeps({
      renderTemplatePng: async (document, layers) => {
        received = { document, layers };
        return PNG_BYTES;
      },
    }),
  );
  await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: AUTH,
    payload: validBody,
  });
  assert.deepEqual(received, {
    document: TPL.document,
    layers: { texts: { displayName: "Micael Crasto" }, images: { avatar: "https://example.com/a.jpg" }, hidden: new Set() },
  });
});

// --- POST /api/v1/render, save:true ------------------------------------------

const NAMED_TPL: TemplateRow = {
  id: "tpl-named",
  ownerId: OWNER_ID,
  kind: "custom",
  name: "Com camadas nomeadas",
  favorite: false,
  document: {
    active: 0,
    pages: [{ w: 100, h: 100, bg: "#000", els: [{ id: "e1", type: "text", name: "titulo", text: "original" }] }],
  },
};

test("save ausente (o padrão) nunca grava — a rota continua só leitura", async () => {
  let updateCalled = false;
  const app = buildApp(makeDeps({
    findTemplate: async () => NAMED_TPL,
    updateTemplate: async () => {
      updateCalled = true;
      return null;
    },
  }));
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: AUTH,
    payload: { template: NAMED_TPL.id, layers: { titulo: { text: "novo" } } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(updateCalled, false);
});

test("save:true grava as camadas resolvidas de volta no próprio template, escopado ao owner", async () => {
  let savedInput: { ownerId: string; id: string; document: unknown } | null = null;
  const app = buildApp(makeDeps({
    findTemplate: async () => NAMED_TPL,
    updateTemplate: async (ownerId, id, input) => {
      savedInput = { ownerId, id, document: input.document };
      return { ...NAMED_TPL, document: input.document };
    },
  }));
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: AUTH,
    payload: { template: NAMED_TPL.id, layers: { titulo: { text: "novo título" } }, save: true },
  });
  assert.equal(res.statusCode, 200);
  // A resposta continua sendo só o PNG — nada novo pra devolver, quem chamou já sabe o id.
  assert.equal(res.headers["content-type"], "image/png");

  if (!savedInput) throw new Error("updateTemplate não foi chamado");
  const captured: { ownerId: string; id: string; document: unknown } = savedInput;
  assert.equal(captured.ownerId, OWNER_ID);
  assert.equal(captured.id, NAMED_TPL.id);
  const saved = captured.document as { pages: Array<{ els: Array<{ text?: string }> }> };
  assert.equal(saved.pages[0].els[0].text, "novo título");
});

// --- templates ---------------------------------------------------------------

test("template/key routes reject calls with no Authorization header", async () => {
  const app = buildApp(makeDeps());
  for (const req of [
    { method: "GET" as const, url: "/api/v1/templates" },
    { method: "POST" as const, url: "/api/v1/templates", payload: { name: "x", document: {} } },
    { method: "GET" as const, url: `/api/v1/templates/${TPL.id}` },
    { method: "GET" as const, url: `/api/v1/templates/${TPL.id}/cover` },
    { method: "PUT" as const, url: `/api/v1/templates/${TPL.id}`, payload: { name: "x" } },
    { method: "DELETE" as const, url: `/api/v1/templates/${TPL.id}` },
    { method: "GET" as const, url: "/api/v1/keys" },
    { method: "POST" as const, url: "/api/v1/keys", payload: { name: "x" } },
    { method: "DELETE" as const, url: "/api/v1/keys/key-1" },
    { method: "DELETE" as const, url: "/api/v1/keys/key-1/purge" },
  ]) {
    const res = await app.inject(req);
    assert.equal(res.statusCode, 401, `${req.method} ${req.url} deveria exigir Authorization`);
  }
});

test("GET /api/v1/templates lists templates", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({ method: "GET", url: "/api/v1/templates", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), [{ id: TPL.id, name: TPL.name, updatedAt: "2024-01-01T00:00:00.000Z", favorite: false }]);
});

test("POST /api/v1/templates creates a template and 400s without a document", async () => {
  const app = buildApp(makeDeps());
  const ok = await app.inject({ method: "POST", url: "/api/v1/templates", headers: AUTH, payload: { name: "Novo", document: {} } });
  assert.equal(ok.statusCode, 201);
  assert.equal(JSON.parse(ok.body).name, "Novo");

  const missing = await app.inject({ method: "POST", url: "/api/v1/templates", headers: AUTH, payload: { name: "Novo" } });
  assert.equal(missing.statusCode, 400);
});

test("GET /api/v1/templates/:id returns the document, 404s when missing", async () => {
  const app = buildApp(makeDeps());
  const ok = await app.inject({ method: "GET", url: `/api/v1/templates/${TPL.id}`, headers: AUTH });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body), { id: TPL.id, name: TPL.name, document: TPL.document, favorite: false });

  const missing = await app.inject({ method: "GET", url: "/api/v1/templates/nope", headers: AUTH });
  assert.equal(missing.statusCode, 404);
});

test("GET /api/v1/templates/:id/cover renders a cover PNG", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({ method: "GET", url: `/api/v1/templates/${TPL.id}/cover`, headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/png");
});

test("PUT /api/v1/templates/:id updates, 404s when missing", async () => {
  const app = buildApp(makeDeps());
  const ok = await app.inject({ method: "PUT", url: `/api/v1/templates/${TPL.id}`, headers: AUTH, payload: { name: "Renomeado" } });
  assert.equal(ok.statusCode, 200);

  const missing = await app.inject({ method: "PUT", url: "/api/v1/templates/nope", headers: AUTH, payload: { name: "x" } });
  assert.equal(missing.statusCode, 404);
});

test("PUT /api/v1/templates/:id toggles favorite without touching the document", async () => {
  let updateInput: unknown;
  const app = buildApp(makeDeps({
    updateTemplate: async (ownerId, id, input) => {
      updateInput = input;
      return id === TPL.id && ownerId === TPL.ownerId ? { ...TPL, ...input } : null;
    },
  }));
  const res = await app.inject({ method: "PUT", url: `/api/v1/templates/${TPL.id}`, headers: AUTH, payload: { favorite: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).favorite, true);
  assert.deepEqual(updateInput, { favorite: true });
});

// --- Storage (fase 7) ---------------------------------------------------------

/** Cliente Supabase Storage falso — só os métodos que server/src/storage.ts chama. */
function makeFakeStorageClient() {
  const uploaded = new Map<string, Buffer>();
  return {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, data: Buffer) => {
          uploaded.set(`${bucket}/${path}`, data);
          return { error: null };
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.supabase.co/storage/v1/object/public/${bucket}/${path}` } }),
        createSignedUrl: async (path: string) => ({
          data: { signedUrl: `https://fake.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=test` },
          error: null,
        }),
        download: async (path: string) => {
          const data = uploaded.get(`${bucket}/${path}`);
          if (!data) return { data: null, error: new Error("not found") };
          return { data: { arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }, error: null };
        },
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("GET /api/v1/templates/:id has no downloadUrl when Storage isn't configured", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({ method: "GET", url: `/api/v1/templates/${TPL.id}`, headers: AUTH });
  assert.equal("downloadUrl" in JSON.parse(res.body), false);
});

test("GET /api/v1/templates/:id includes a deterministic public downloadUrl when Storage is configured", async () => {
  const app = buildApp(makeDeps(), null, { client: makeFakeStorageClient() });
  const res = await app.inject({ method: "GET", url: `/api/v1/templates/${TPL.id}`, headers: AUTH });
  const body = JSON.parse(res.body);
  assert.match(body.downloadUrl, /\/renders\/tpl-1\/page-1\.png$/);
});

test("POST /api/v1/uploads responds 501 when Storage isn't configured", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({ method: "POST", url: "/api/v1/uploads", headers: AUTH });
  assert.equal(res.statusCode, 501);
});

test("POST /api/v1/uploads requires auth even when Storage is configured", async () => {
  const app = buildApp(makeDeps(), null, { client: makeFakeStorageClient() });
  const res = await app.inject({ method: "POST", url: "/api/v1/uploads" });
  assert.equal(res.statusCode, 401);
});

test("POST /api/v1/generations requires Storage before creating a design", async () => {
  let created = false;
  const app = buildApp(makeDeps({
    createTemplate: async (ownerId, { name, document }) => {
      created = true;
      return { id: "generated", ownerId, kind: "custom", name, document, favorite: false };
    },
  }));
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/generations",
    headers: { ...AUTH, "idempotency-key": "run-1" },
    payload: { template: TPL.id, name: "Gerado", pages: [{ layers: {} }] },
  });

  assert.equal(res.statusCode, 501);
  assert.equal(created, false);
});

test("POST /api/v1/generations requires an authenticated owner", async () => {
  const app = buildApp(makeDeps(), null, { client: makeFakeStorageClient() });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/generations",
    headers: { "idempotency-key": "run-1" },
    payload: { template: TPL.id, name: "Gerado", pages: [{ layers: {} }] },
  });

  assert.equal(res.statusCode, 401);
});

test("POST /api/v1/generations cannot clone a template owned by another account", async () => {
  let created = false;
  const app = buildApp(makeDeps({
    findApiKeyOwner: async () => ({ ownerId: "other-owner" }),
    createTemplate: async (ownerId, { name, document }) => {
      created = true;
      return { id: "generated", ownerId, kind: "custom", name, document, favorite: false };
    },
  }), null, { client: makeFakeStorageClient() });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/generations",
    headers: { ...AUTH, "idempotency-key": "other-owner-run" },
    payload: { template: TPL.id, name: "Gerado", pages: [{ layers: {} }] },
  });

  assert.equal(res.statusCode, 404);
  assert.equal(created, false);
});

test("POST /api/v1/generations requires an Idempotency-Key", async () => {
  const app = buildApp(makeDeps(), null, { client: makeFakeStorageClient() });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/generations",
    headers: AUTH,
    payload: { template: TPL.id, name: "Gerado", pages: [{ layers: {} }] },
  });

  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /Idempotency-Key/);
});

test("POST /api/v1/generations creates and renders an editable design from a one-page template", async () => {
  const source: TemplateRow = {
    ...TPL,
    id: "automation-card",
    name: "Card para automação",
    document: {
      name: "Card para automação",
      active: 0,
      pages: [{
        id: "source-page",
        w: 1080,
        h: 1350,
        bg: "#000",
        els: [
          { id: "title", type: "text", name: "titulo", text: "Título" },
          { id: "body", type: "text", name: "corpo", text: "Corpo" },
        ],
      }],
    },
  };
  let created: TemplateRow | null = null;
  const renderedPages: number[] = [];
  const deps = makeDeps({
    findTemplate: async (ownerId, id) => {
      if (ownerId !== OWNER_ID) return null;
      if (id === source.id) return source;
      return created?.id === id ? created : null;
    },
    createTemplate: async (ownerId, input) => {
      created = { id: input.id!, ownerId, kind: "custom", name: input.name, document: input.document, favorite: false };
      return created;
    },
    renderTemplatePng: async (_document, _layers, pageIndex) => {
      renderedPages.push(pageIndex!);
      return PNG_BYTES;
    },
  });
  const app = buildApp(deps, null, { client: makeFakeStorageClient() });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/generations",
    headers: { ...AUTH, "idempotency-key": "briefing-1" },
    payload: {
      template: source.id,
      name: "Carrossel novo",
      pages: [
        { layers: { titulo: { text: "Capa" }, corpo: { text: "Abertura" } } },
        { layers: { titulo: { text: "Fim" }, corpo: { text: "Conclusão" } } },
      ],
    },
  });
  const body = JSON.parse(res.body);
  const document = created!.document as { name: string; active: number; pages: Array<{ id: string; els: Array<{ name: string; text: string }> }> };

  assert.deepEqual({
    status: res.statusCode,
    response: {
      id: body.design.id,
      name: body.design.name,
      pageCount: body.design.pageCount,
      editorPath: body.design.editorPath,
      pages: body.design.pages,
    },
    stored: {
      id: created!.id,
      name: document.name,
      active: document.active,
      pageCount: document.pages.length,
      titles: document.pages.map((page) => page.els.find((element) => element.name === "titulo")?.text),
      uniquePageIds: new Set(document.pages.map((page) => page.id)).size,
    },
    renderedPages,
  }, {
    status: 201,
    response: {
      id: created!.id,
      name: "Carrossel novo",
      pageCount: 2,
      editorPath: `/#/editor/${created!.id}`,
      pages: [
        { page: 1, pngUrl: `https://fake.supabase.co/storage/v1/object/sign/draft-renders/${OWNER_ID}/${body.generation.id}/versions/1/page-1.png?token=test` },
        { page: 2, pngUrl: `https://fake.supabase.co/storage/v1/object/sign/draft-renders/${OWNER_ID}/${body.generation.id}/versions/1/page-2.png?token=test` },
      ],
    },
    stored: {
      id: created!.id,
      name: "Carrossel novo",
      active: 0,
      pageCount: 2,
      titles: ["Capa", "Fim"],
      uniquePageIds: 2,
    },
    renderedPages: [0, 1],
  });
});

test("save:true keeps a generated design in private draft storage until approval", async () => {
  const templates = new Map<string, TemplateRow>([[TPL.id, TPL]]);
  const uploadedBuckets: string[] = [];
  const storage = {
    storage: {
      from: (bucket: string) => ({
        upload: async () => { uploadedBuckets.push(bucket); return { error: null }; },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.test/public/${bucket}/${path}` } }),
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://storage.test/signed/${bucket}/${path}` }, error: null }),
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const deps = makeDeps({
    findTemplate: async (ownerId, id) => templates.get(id)?.ownerId === ownerId ? templates.get(id)! : null,
    createTemplate: async (ownerId, input) => {
      const row = { id: input.id!, ownerId, kind: "custom", name: input.name, document: input.document, favorite: false };
      templates.set(row.id, row);
      return row;
    },
    updateTemplate: async (ownerId, id, input) => {
      const row = templates.get(id);
      if (!row || row.ownerId !== ownerId) return null;
      const updated = { ...row, name: input.name ?? row.name, document: input.document ?? row.document };
      templates.set(id, updated);
      return updated;
    },
  });
  const app = buildApp(deps, null, { client: storage });
  const generated = await app.inject({
    method: "POST", url: "/api/v1/generations",
    headers: { ...AUTH, "idempotency-key": "private-edit" },
    payload: { template: TPL.id, name: "Gerado", pages: [{ layers: {} }] },
  });
  const designId = JSON.parse(generated.body).design.id;
  uploadedBuckets.length = 0;

  const rendered = await app.inject({
    method: "POST", url: "/api/v1/render", headers: AUTH,
    payload: { template: designId, layers: {}, save: true },
  });

  assert.equal(rendered.statusCode, 200);
  assert.deepEqual(uploadedBuckets, ["draft-renders"]);
});

test("POST /api/v1/generations replays the same design without overwriting manual edits", async () => {
  const source: TemplateRow = {
    ...TPL,
    id: "automation-card",
    document: {
      name: "Card",
      active: 0,
      pages: [{ id: "source", w: 1080, h: 1350, bg: "#000", els: [
        { id: "title", type: "text", name: "titulo", text: "Título" },
      ] }],
    },
  };
  let stored: TemplateRow | null = null;
  let creates = 0;
  const renderedTitles: string[] = [];
  const deps = makeDeps({
    findTemplate: async (ownerId, id) => {
      if (ownerId !== OWNER_ID) return null;
      if (id === source.id) return source;
      return stored?.id === id ? stored : null;
    },
    createTemplate: async (ownerId, input) => {
      creates += 1;
      stored = { id: input.id!, ownerId, kind: "custom", name: input.name, document: input.document, favorite: false };
      return stored;
    },
    renderTemplatePng: async (document) => {
      const doc = document as { pages: Array<{ els: Array<{ name: string; text: string }> }> };
      renderedTitles.push(doc.pages[0].els.find((element) => element.name === "titulo")!.text);
      return PNG_BYTES;
    },
  });
  const app = buildApp(deps, null, { client: makeFakeStorageClient() });
  const request = {
    method: "POST" as const,
    url: "/api/v1/generations",
    headers: { ...AUTH, "idempotency-key": "same-run" },
    payload: { template: source.id, name: "Gerado", pages: [{ layers: { titulo: { text: "IA" } } }] },
  };
  const first = await app.inject(request);
  const doc = stored!.document as { pages: Array<{ els: Array<{ name: string; text: string }> }> };
  doc.pages[0].els.find((element) => element.name === "titulo")!.text = "Edição manual";
  const second = await app.inject(request);

  assert.deepEqual({
    firstStatus: first.statusCode,
    secondStatus: second.statusCode,
    sameId: JSON.parse(first.body).design.id === JSON.parse(second.body).design.id,
    creates,
    renderedTitles,
  }, {
    firstStatus: 201,
    secondStatus: 200,
    sameId: true,
    creates: 1,
    renderedTitles: ["IA", "Edição manual"],
  });
});

test("POST /api/v1/generations rejects reuse of an Idempotency-Key with a different body", async () => {
  const templates = new Map<string, TemplateRow>([[TPL.id, TPL]]);
  const deps = makeDeps({
    findTemplate: async (ownerId, id) => templates.get(id)?.ownerId === ownerId ? templates.get(id)! : null,
    createTemplate: async (ownerId, input) => {
      const row = { id: input.id!, ownerId, kind: "custom", name: input.name, document: input.document, favorite: false };
      templates.set(row.id, row);
      return row;
    },
  });
  const app = buildApp(deps, null, { client: makeFakeStorageClient() });
  const first = await app.inject({
    method: "POST", url: "/api/v1/generations", headers: { ...AUTH, "idempotency-key": "same-key" },
    payload: { template: TPL.id, name: "Primeiro", pages: [{ layers: {} }] },
  });
  const conflict = await app.inject({
    method: "POST", url: "/api/v1/generations", headers: { ...AUTH, "idempotency-key": "same-key" },
    payload: { template: TPL.id, name: "Mudou", pages: [{ layers: {} }] },
  });
  assert.equal(first.statusCode, 201);
  assert.equal(conflict.statusCode, 409);
  assert.equal(JSON.parse(conflict.body).error, "IDEMPOTENCY_CONFLICT");
});

test("POST /api/v1/generations acquires a requested stock image and persists its private Storage ref", async () => {
  const source: TemplateRow = {
    ...TPL,
    id: "image-card",
    document: { name: "Card", active: 0, pages: [{ id: "p1", w: 1080, h: 1350, bg: "#000", els: [
      { id: "photo", type: "image", name: "imagem", src: "" },
    ] }] },
  };
  let generated: TemplateRow | null = null;
  let requested: unknown = null;
  let recordedProvider = "";
  const repository = createMemoryGenerationRepository();
  const originalRecord = repository.recordMediaAsset.bind(repository);
  repository.recordMediaAsset = async (input) => {
    recordedProvider = input.provider;
    await originalRecord(input);
  };
  const deps = makeDeps({
    generations: repository,
    findTemplate: async (ownerId, id) => ownerId !== OWNER_ID ? null : id === source.id ? source : generated?.id === id ? generated : null,
    createTemplate: async (ownerId, input) => {
      generated = { id: input.id!, ownerId, kind: "custom", name: input.name, document: input.document, favorite: false };
      return generated;
    },
  });
  const app = buildApp(deps, null, { client: makeFakeStorageClient() }, { service: {
    acquire: async (input) => {
      requested = input;
      return {
        bytes: Buffer.from("image"), contentType: "image/jpeg" as const, extension: "jpg" as const,
        width: 1200, height: 1500, provider: "pexels" as const, externalId: "42", author: "Ada",
        attributionUrl: "https://pexels.test/photo/42", licenseUrl: "https://pexels.test/license",
        prompt: "professora brasileira", model: null,
      };
    },
  } });
  const response = await app.inject({
    method: "POST", url: "/api/v1/generations",
    headers: { ...AUTH, "idempotency-key": "with-stock" },
    payload: { template: source.id, name: "Com foto", pages: [{ layers: {
      imagem: { asset: { strategy: "stock", query: "professora brasileira", aspectRatio: "4:5" } },
    } }] },
  });
  const image = (generated!.document as { pages: Array<{ els: Array<{ src: string }> }> }).pages[0].els[0];
  assert.equal(response.statusCode, 201);
  assert.deepEqual(requested, { strategy: "stock", query: "professora brasileira", aspectRatio: "4:5" });
  assert.match(image.src, /^supabase:\/\/uploads\/owner-1\//);
  assert.equal(recordedProvider, "pexels");
  assert.equal(JSON.parse(response.body).generation.reviewStatus, "pending");
});

test("POST /api/v1/generations validates every media request before calling a paid provider", async () => {
  const source: TemplateRow = {
    ...TPL,
    id: "image-card-preflight",
    document: { name: "Card", active: 0, pages: [{ id: "p1", w: 1080, h: 1350, bg: "#000", els: [
      { id: "photo", type: "image", name: "imagem", src: "" },
    ] }] },
  };
  let providerCalls = 0;
  const app = buildApp(makeDeps({
    findTemplate: async (ownerId, id) => ownerId === OWNER_ID && id === source.id ? source : null,
  }), null, { client: makeFakeStorageClient() }, { service: {
    acquire: async () => {
      providerCalls += 1;
      throw new Error("must not be reached");
    },
  } });

  const response = await app.inject({
    method: "POST", url: "/api/v1/generations",
    headers: { ...AUTH, "idempotency-key": "invalid-second-media" },
    payload: { template: source.id, name: "Com foto", pages: [
      { layers: { imagem: { asset: { strategy: "stock", query: "válida" } } } },
      { layers: { imagem: { asset: { strategy: "unsupported", query: "inválida" } } } },
    ] },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(providerCalls, 0);
  assert.match(JSON.parse(response.body).error, /strategy must be stock or ai/);
});

test("POST /api/v1/generations treats a concurrent idempotent insert as a replay", async () => {
  const source: TemplateRow = {
    ...TPL,
    id: "automation-card",
    document: {
      name: "Card",
      active: 0,
      pages: [{ id: "source", w: 1080, h: 1350, bg: "#000", els: [
        { id: "title", type: "text", name: "titulo", text: "Título" },
      ] }],
    },
  };
  let winner: TemplateRow | null = null;
  const renderedTitles: string[] = [];
  const deps = makeDeps({
    findTemplate: async (ownerId, id) => {
      if (ownerId !== OWNER_ID) return null;
      if (id === source.id) return source;
      return winner?.id === id ? winner : null;
    },
    createTemplate: async (ownerId, input) => {
      winner = {
        id: input.id!,
        ownerId,
        kind: "custom",
        name: "Primeiro vencedor",
        favorite: false,
        document: {
          name: "Primeiro vencedor",
          active: 0,
          pages: [{ id: "winner-page", w: 1080, h: 1350, bg: "#000", els: [
            { id: "winner-title", type: "text", name: "titulo", text: "Edição vencedora" },
          ] }],
        },
      };
      throw new Error("duplicate key value violates unique constraint");
    },
    renderTemplatePng: async (document) => {
      const doc = document as { pages: Array<{ els: Array<{ name: string; text: string }> }> };
      renderedTitles.push(doc.pages[0].els.find((element) => element.name === "titulo")!.text);
      return PNG_BYTES;
    },
  });
  const app = buildApp(deps, null, { client: makeFakeStorageClient() });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/generations",
    headers: { ...AUTH, "idempotency-key": "concurrent-run" },
    payload: { template: source.id, name: "Segundo concorrente", pages: [{ layers: { titulo: { text: "Perdedor" } } }] },
  });

  assert.deepEqual({
    status: res.statusCode,
    name: JSON.parse(res.body).design?.name,
    renderedTitles,
  }, {
    status: 200,
    name: "Primeiro vencedor",
    renderedTitles: ["Perdedor", "Edição vencedora"],
  });
});

test("POST /api/v1/generations rejects a page without a layers object", async () => {
  const app = buildApp(makeDeps(), null, { client: makeFakeStorageClient() });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/generations",
    headers: { ...AUTH, "idempotency-key": "bad-page" },
    payload: { template: TPL.id, name: "Gerado", pages: [{}] },
  });

  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /pages\[0\]\.layers/);
});

test("POST /api/v1/generations reports a Storage upload outage", async () => {
  const failingStorage = {
    storage: {
      from: (bucket: string) => ({
        upload: async () => ({ error: new Error("storage offline") }),
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.supabase.co/${bucket}/${path}` } }),
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const app = buildApp(makeDeps(), null, { client: failingStorage });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/generations",
    headers: { ...AUTH, "idempotency-key": "storage-outage" },
    payload: { template: TPL.id, name: "Gerado", pages: [{ layers: {} }] },
  });

  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /storage offline/);
});

// --- API keys ------------------------------------------------------------------

test("GET /api/v1/keys lists keys without exposing a secret", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({ method: "GET", url: "/api/v1/keys", headers: AUTH });
  const body = JSON.parse(res.body);
  assert.equal(body.length, 1);
  assert.equal(body[0].secret, undefined);
});

test("POST /api/v1/keys creates a key and returns its plaintext secret once, 400s without a name", async () => {
  const app = buildApp(makeDeps());
  const ok = await app.inject({ method: "POST", url: "/api/v1/keys", headers: AUTH, payload: { name: "n8n" } });
  assert.equal(ok.statusCode, 201);
  assert.equal(JSON.parse(ok.body).secret, "blk_live_generated");

  const missing = await app.inject({ method: "POST", url: "/api/v1/keys", headers: AUTH, payload: {} });
  assert.equal(missing.statusCode, 400);
});

test("DELETE /api/v1/keys/:id revokes, 404s when already revoked or missing", async () => {
  const app = buildApp(makeDeps());
  const ok = await app.inject({ method: "DELETE", url: "/api/v1/keys/key-1", headers: AUTH });
  assert.equal(ok.statusCode, 204);

  const missing = await app.inject({ method: "DELETE", url: "/api/v1/keys/nope", headers: AUTH });
  assert.equal(missing.statusCode, 404);
});

test("DELETE /api/v1/keys/:id/purge permanently removes a revoked key, 404s otherwise", async () => {
  const app = buildApp(makeDeps());
  const ok = await app.inject({ method: "DELETE", url: "/api/v1/keys/revoked-key/purge", headers: AUTH });
  assert.equal(ok.statusCode, 204);

  const notRevoked = await app.inject({ method: "DELETE", url: "/api/v1/keys/key-1/purge", headers: AUTH });
  assert.equal(notRevoked.statusCode, 404);
});

test("DELETE /api/v1/templates/:id removes it, 404s when missing", async () => {
  const app = buildApp(makeDeps());
  const ok = await app.inject({ method: "DELETE", url: `/api/v1/templates/${TPL.id}`, headers: AUTH });
  assert.equal(ok.statusCode, 204);

  const missing = await app.inject({ method: "DELETE", url: "/api/v1/templates/nope", headers: AUTH });
  assert.equal(missing.statusCode, 404);
});

// --- POST /api/v1/render, seleção de página ---------------------------------

test("renders the document's own active page when no page is requested", async () => {
  const { deps, calls } = makeMultiPageDeps();
  const app = buildApp(deps);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: AUTH,
    payload: { template: CARROSSEL.id },
  });
  assert.equal(res.statusCode, 200);
  // undefined, não 0: o renderer é quem lê `active` do documento. Mandar 0 daqui
  // passaria por cima de um documento cuja página ativa é outra.
  assert.deepEqual(calls, [undefined]);
});

test("renders the requested page, converting the API's 1-based number to a 0-based index", async () => {
  const { deps, calls } = makeMultiPageDeps();
  const app = buildApp(deps);
  for (const page of [1, 2, 3]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/render",
      headers: AUTH,
      payload: { template: CARROSSEL.id, page },
    });
    assert.equal(res.statusCode, 200);
  }
  assert.deepEqual(calls, [0, 1, 2]);
});

test("rejects a page beyond the template's last one instead of clamping to it", async () => {
  const { deps, calls } = makeMultiPageDeps();
  const app = buildApp(deps);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: AUTH,
    payload: { template: CARROSSEL.id, page: 4 },
  });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /between 1 and 3/);
  // Não renderizou nada: silenciosamente devolver a página 3 faria o chamador
  // acreditar que gerou o slide 4.
  assert.deepEqual(calls, []);
});

test("rejects page 0 and non-integer pages", async () => {
  const { deps } = makeMultiPageDeps();
  const app = buildApp(deps);
  for (const page of [0, -1, 1.5]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/render",
      headers: AUTH,
      payload: { template: CARROSSEL.id, page },
    });
    assert.equal(res.statusCode, 400, `page ${page} deveria ser recusada`);
  }
});

test("rejects any page other than 1 on a single-page template", async () => {
  const { deps } = makeMultiPageDeps();
  const app = buildApp(deps);
  const ok = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: AUTH,
    payload: { template: TPL.id, page: 1 },
  });
  assert.equal(ok.statusCode, 200);
  const bad = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: AUTH,
    payload: { template: TPL.id, page: 2 },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(JSON.parse(bad.body).error, /between 1 and 1/);
});
