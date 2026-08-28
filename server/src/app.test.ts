import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp, type AppDeps } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import type { TemplateRow } from "./db.ts";

const VALID_KEY = "blk_live_test";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // just needs to be *a* buffer for these tests

const TPL: TemplateRow = {
  id: "tpl-1",
  kind: "tweet",
  name: "Tweet",
  document: { active: 0, pages: [{ w: 566, h: 120, bg: "#000", els: [] }] },
};

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    findApiKeyOwner: async (keyHash) =>
      keyHash === hashApiKey(VALID_KEY) ? { id: "owner-1", name: "test key" } : null,
    findTemplate: async (id) => (id === TPL.id ? TPL : null),
    listTemplates: async () => [{ id: TPL.id, name: TPL.name, updatedAt: "2024-01-01T00:00:00.000Z" }],
    createTemplate: async ({ name, document }) => ({ id: "new-tpl", kind: "custom", name, document }),
    updateTemplate: async (id, input) => (id === TPL.id ? { ...TPL, ...input } : null),
    deleteTemplate: async (id) => id === TPL.id,
    listApiKeys: async () => [{ id: "key-1", name: "prod", createdAt: "2024-01-01T00:00:00.000Z", revoked: false }],
    createApiKey: async (name) => ({ id: "new-key", name, secret: "blk_live_generated", createdAt: "2024-01-01T00:00:00.000Z" }),
    revokeApiKey: async (id) => id === "key-1",
    deleteApiKey: async (id) => id === "revoked-key",
    findWorkspaceByEmail: async () => null,
    createWorkspace: async ({ name, email }) => ({ id: "new-workspace", name, email }),
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
    findTemplate: async (id) => (id === TPL.id ? TPL : id === CARROSSEL.id ? CARROSSEL : null),
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
    headers: { authorization: `Bearer ${VALID_KEY}` },
    payload: { ...validBody, template: "does-not-exist" },
  });
  assert.equal(res.statusCode, 404);
});

test("returns a PNG image on a valid authenticated request", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: { authorization: `Bearer ${VALID_KEY}` },
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
    headers: { authorization: `Bearer ${VALID_KEY}` },
    payload: validBody,
  });
  assert.deepEqual(received, {
    document: TPL.document,
    layers: { texts: { displayName: "Micael Crasto" }, images: { avatar: "https://example.com/a.jpg" }, hidden: new Set() },
  });
});

// --- templates ---------------------------------------------------------------

test("GET /api/v1/templates lists templates", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({ method: "GET", url: "/api/v1/templates" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), [{ id: TPL.id, name: TPL.name, updatedAt: "2024-01-01T00:00:00.000Z" }]);
});

test("POST /api/v1/templates creates a template and 400s without a document", async () => {
  const app = buildApp(makeDeps());
  const ok = await app.inject({ method: "POST", url: "/api/v1/templates", payload: { name: "Novo", document: {} } });
  assert.equal(ok.statusCode, 201);
  assert.equal(JSON.parse(ok.body).name, "Novo");

  const missing = await app.inject({ method: "POST", url: "/api/v1/templates", payload: { name: "Novo" } });
  assert.equal(missing.statusCode, 400);
});

test("GET /api/v1/templates/:id returns the document, 404s when missing", async () => {
  const app = buildApp(makeDeps());
  const ok = await app.inject({ method: "GET", url: `/api/v1/templates/${TPL.id}` });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body), { id: TPL.id, name: TPL.name, document: TPL.document });

  const missing = await app.inject({ method: "GET", url: "/api/v1/templates/nope" });
  assert.equal(missing.statusCode, 404);
});

test("PUT /api/v1/templates/:id updates, 404s when missing", async () => {
  const app = buildApp(makeDeps());
  const ok = await app.inject({ method: "PUT", url: `/api/v1/templates/${TPL.id}`, payload: { name: "Renomeado" } });
  assert.equal(ok.statusCode, 200);

  const missing = await app.inject({ method: "PUT", url: "/api/v1/templates/nope", payload: { name: "x" } });
  assert.equal(missing.statusCode, 404);
});

// --- API keys ------------------------------------------------------------------

test("GET /api/v1/keys lists keys without exposing a secret", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({ method: "GET", url: "/api/v1/keys" });
  const body = JSON.parse(res.body);
  assert.equal(body.length, 1);
  assert.equal(body[0].secret, undefined);
});

test("POST /api/v1/keys creates a key and returns its plaintext secret once, 400s without a name", async () => {
  const app = buildApp(makeDeps());
  const ok = await app.inject({ method: "POST", url: "/api/v1/keys", payload: { name: "n8n" } });
  assert.equal(ok.statusCode, 201);
  assert.equal(JSON.parse(ok.body).secret, "blk_live_generated");

  const missing = await app.inject({ method: "POST", url: "/api/v1/keys", payload: {} });
  assert.equal(missing.statusCode, 400);
});

test("DELETE /api/v1/keys/:id revokes, 404s when already revoked or missing", async () => {
  const app = buildApp(makeDeps());
  const ok = await app.inject({ method: "DELETE", url: "/api/v1/keys/key-1" });
  assert.equal(ok.statusCode, 204);

  const missing = await app.inject({ method: "DELETE", url: "/api/v1/keys/nope" });
  assert.equal(missing.statusCode, 404);
});

test("DELETE /api/v1/keys/:id/purge permanently removes a revoked key, 404s otherwise", async () => {
  const app = buildApp(makeDeps());
  const ok = await app.inject({ method: "DELETE", url: "/api/v1/keys/revoked-key/purge" });
  assert.equal(ok.statusCode, 204);

  const notRevoked = await app.inject({ method: "DELETE", url: "/api/v1/keys/key-1/purge" });
  assert.equal(notRevoked.statusCode, 404);
});

test("DELETE /api/v1/templates/:id removes it, 404s when missing", async () => {
  const app = buildApp(makeDeps());
  const ok = await app.inject({ method: "DELETE", url: `/api/v1/templates/${TPL.id}` });
  assert.equal(ok.statusCode, 204);

  const missing = await app.inject({ method: "DELETE", url: "/api/v1/templates/nope" });
  assert.equal(missing.statusCode, 404);
});

// --- POST /api/v1/render, seleção de página ---------------------------------

test("renders the document's own active page when no page is requested", async () => {
  const { deps, calls } = makeMultiPageDeps();
  const app = buildApp(deps);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: { authorization: `Bearer ${VALID_KEY}` },
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
      headers: { authorization: `Bearer ${VALID_KEY}` },
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
    headers: { authorization: `Bearer ${VALID_KEY}` },
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
      headers: { authorization: `Bearer ${VALID_KEY}` },
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
    headers: { authorization: `Bearer ${VALID_KEY}` },
    payload: { template: TPL.id, page: 1 },
  });
  assert.equal(ok.statusCode, 200);
  const bad = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: { authorization: `Bearer ${VALID_KEY}` },
    payload: { template: TPL.id, page: 2 },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(JSON.parse(bad.body).error, /between 1 and 1/);
});

// --- POST /api/v1/workspace, GET /api/v1/workspace/by-email/:email --------

test("signing up creates a workspace and returns it with a 201", async () => {
  const app = buildApp(makeDeps({
    findWorkspaceByEmail: async () => null,
    createWorkspace: async ({ name, email }) => ({ id: "ws-1", name, email }),
  }));
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/workspace",
    payload: { name: "Studio do Miguel", email: "miguel@blankschool.com.br" },
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(JSON.parse(res.body), { id: "ws-1", name: "Studio do Miguel", email: "miguel@blankschool.com.br" });
});

test("rejects signup with a missing name or email", async () => {
  const app = buildApp(makeDeps());
  for (const payload of [{ email: "a@b.com" }, { name: "A" }, {}]) {
    const res = await app.inject({ method: "POST", url: "/api/v1/workspace", payload });
    assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)} deveria ser recusado`);
  }
});

test("rejects signup when the e-mail is already taken, without calling createWorkspace", async () => {
  let created = false;
  const app = buildApp(makeDeps({
    findWorkspaceByEmail: async () => ({ id: "ws-existing", name: "Já existe", email: "miguel@blankschool.com.br" }),
    createWorkspace: async ({ name, email }) => {
      created = true;
      return { id: "should-not-happen", name, email };
    },
  }));
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/workspace",
    payload: { name: "Outro nome", email: "miguel@blankschool.com.br" },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(created, false);
});

test("logging in finds the workspace by e-mail", async () => {
  const app = buildApp(makeDeps({
    findWorkspaceByEmail: async (email) =>
      email === "miguel@blankschool.com.br" ? { id: "ws-1", name: "Studio do Miguel", email } : null,
  }));
  const res = await app.inject({ method: "GET", url: "/api/v1/workspace/by-email/miguel@blankschool.com.br" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { id: "ws-1", name: "Studio do Miguel", email: "miguel@blankschool.com.br" });
});

test("logging in with an unknown e-mail is a 404, not a silent success", async () => {
  const app = buildApp(makeDeps({ findWorkspaceByEmail: async () => null }));
  const res = await app.inject({ method: "GET", url: "/api/v1/workspace/by-email/nao-existe@example.com" });
  assert.equal(res.statusCode, 404);
});
