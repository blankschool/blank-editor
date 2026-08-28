import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp, type AppDeps } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import type { TemplateRow } from "./db.ts";

const VALID_KEY = "blk_live_test";
const OWNER_ID = "owner-1";
const AUTH = { authorization: `Bearer ${VALID_KEY}` };
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // just needs to be *a* buffer for these tests

const TPL: TemplateRow = {
  id: "tpl-1",
  ownerId: OWNER_ID,
  kind: "tweet",
  name: "Tweet",
  document: { active: 0, pages: [{ w: 566, h: 120, bg: "#000", els: [] }] },
};

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    findApiKeyOwner: async (keyHash) => (keyHash === hashApiKey(VALID_KEY) ? { ownerId: OWNER_ID } : null),
    findTemplate: async (ownerId, id) => (id === TPL.id && ownerId === TPL.ownerId ? TPL : null),
    listTemplates: async (ownerId) =>
      ownerId === OWNER_ID ? [{ id: TPL.id, name: TPL.name, updatedAt: "2024-01-01T00:00:00.000Z" }] : [],
    createTemplate: async (ownerId, { name, document }) => ({ id: "new-tpl", ownerId, kind: "custom", name, document }),
    updateTemplate: async (ownerId, id, input) => (id === TPL.id && ownerId === TPL.ownerId ? { ...TPL, ...input } : null),
    deleteTemplate: async (ownerId, id) => id === TPL.id && ownerId === TPL.ownerId,
    listApiKeys: async (ownerId) =>
      ownerId === OWNER_ID ? [{ id: "key-1", name: "prod", createdAt: "2024-01-01T00:00:00.000Z", revoked: false }] : [],
    createApiKey: async (ownerId, name) => ({ id: "new-key", name, secret: "blk_live_generated", createdAt: "2024-01-01T00:00:00.000Z" }),
    revokeApiKey: async (ownerId, id) => id === "key-1" && ownerId === OWNER_ID,
    deleteApiKey: async (ownerId, id) => id === "revoked-key" && ownerId === OWNER_ID,
    renderTemplatePng: async () => PNG_BYTES,
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
  assert.deepEqual(JSON.parse(res.body), [{ id: TPL.id, name: TPL.name, updatedAt: "2024-01-01T00:00:00.000Z" }]);
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
  assert.deepEqual(JSON.parse(ok.body), { id: TPL.id, name: TPL.name, document: TPL.document });

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
