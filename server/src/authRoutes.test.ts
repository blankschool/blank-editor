import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp, type AppDeps, type AuthDeps } from "./app.ts";
import type { TemplateRow } from "./db.ts";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const OWNER_ID = "user-1";

/** Usuário e sessão falsos, o bastante pro que supabaseAuth.ts lê de um SupabaseClient real. */
const FAKE_USER = { id: OWNER_ID, email: "miguel@example.com", user_metadata: { name: "Studio do Miguel" } };
const FAKE_SESSION = { access_token: "fake-access-token", refresh_token: "fake-refresh-token", expires_in: 3600 };

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const templates = new Map<string, TemplateRow>();
  return {
    findApiKeyOwner: async () => null,
    findTemplate: async (ownerId, id) => {
      const row = templates.get(id);
      return row && row.ownerId === ownerId ? row : null;
    },
    listTemplates: async (ownerId) =>
      [...templates.values()].filter((t) => t.ownerId === ownerId).map((t) => ({ id: t.id, name: t.name, updatedAt: "2024-01-01T00:00:00.000Z", favorite: t.favorite })),
    createTemplate: async (ownerId, { id, name, document }) => {
      const row: TemplateRow = { id: id ?? `tpl-${templates.size + 1}`, ownerId, kind: "custom", name, document, favorite: false };
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
    deleteTemplate: async () => false,
    listDesignVersions: async () => [],
    createDesignVersion: async () => { throw new Error("not used in these tests"); },
    findDesignVersion: async () => null,
    deleteDesignVersion: async () => false,
    getDesignShareVisibility: async () => "private",
    setDesignShareVisibility: async () => {},
    getPublicShareVisibility: async () => "private",
    findTemplatePublic: async () => null,
    listDesignComments: async () => [],
    createDesignComment: async () => { throw new Error("not implemented in this test stub"); },
    setDesignCommentResolved: async () => false,
    deleteDesignComment: async () => false,
    createDesignCommentReply: async () => null,
    buscarCuradoria: async () => ({ topicos: [], referencias: [] }),
    listBrandKits: async () => [],
    createBrandKit: async () => { throw new Error("not implemented in this test stub"); },
    deleteBrandKit: async () => false,
    upsertFontFace: async (input) => ({
      id: input.id, sha256: input.sha256, internalFamily: input.internalFamily,
      postscriptName: input.postscriptName ?? null, weight: input.weight, style: input.style,
      stretch: input.stretch ?? null, os2FsType: input.os2FsType ?? null,
      sfntPath: input.sfntPath, woff2Path: input.woff2Path,
    }),
    listFontFaces: async () => [],
    listApiKeys: async () => [],
    createApiKey: async (ownerId, name) => ({ id: "key-1", name, secret: "blk_live_generated", createdAt: "2024-01-01T00:00:00.000Z" }),
    revokeApiKey: async () => false,
    deleteApiKey: async () => false,
    renderTemplatePng: async () => PNG_BYTES,
    ...overrides,
  };
}

/** Cliente Supabase falso: só os métodos que server/src/supabaseAuth.ts realmente chama. */
function makeFakeSupabaseClient(opts: { validAccessToken?: string } = {}) {
  const validAccessToken = opts.validAccessToken ?? FAKE_SESSION.access_token;
  return {
    auth: {
      signUp: async () => ({ data: { user: FAKE_USER, session: FAKE_SESSION }, error: null }),
      signInWithPassword: async ({ email, password }: { email: string; password: string }) =>
        email === FAKE_USER.email && password === "senha-certa"
          ? { data: { user: FAKE_USER, session: FAKE_SESSION }, error: null }
          : { data: { user: null, session: null }, error: new Error("invalid credentials") },
      getUser: async (token: string) =>
        token === validAccessToken ? { data: { user: FAKE_USER }, error: null } : { data: { user: null }, error: new Error("invalid token") },
      refreshSession: async ({ refresh_token }: { refresh_token: string }) =>
        refresh_token === FAKE_SESSION.refresh_token
          ? { data: { session: { ...FAKE_SESSION, access_token: "refreshed-access-token" } }, error: null }
          : { data: { session: null }, error: new Error("invalid refresh token") },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeAuth(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    client: makeFakeSupabaseClient(),
    createDefaultApiKey: async (ownerId) => ({ id: "default-key", name: "Chave padrão", secret: "blk_live_default", createdAt: "2024-01-01T00:00:00.000Z" }),
    ...overrides,
  };
}

function cookieHeader(res: { cookies: Array<{ name: string; value: string }> }): string {
  return res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function makeFakeStorageClient() {
  return {
    storage: {
      from: (bucket: string) => ({
        upload: async () => ({ error: null }),
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.test/public/${bucket}/${path}` } }),
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://storage.test/signed/${bucket}/${path}` }, error: null }),
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// --- sem Supabase configurado -------------------------------------------------

test("auth routes respond 501 when Supabase Auth isn't configured", async () => {
  const app = buildApp(makeDeps(), null);
  for (const req of [
    { method: "POST" as const, url: "/api/v1/auth/signup", payload: {} },
    { method: "POST" as const, url: "/api/v1/auth/login", payload: {} },
    { method: "POST" as const, url: "/api/v1/auth/refresh" },
    { method: "GET" as const, url: "/api/v1/auth/me" },
  ]) {
    const res = await app.inject(req);
    assert.equal(res.statusCode, 501, `${req.method} ${req.url}`);
  }
});

// --- signup --------------------------------------------------------------------

test("signup creates a session cookie, a default API key, and scopes templates to the new owner", async () => {
  const app = buildApp(makeDeps(), makeAuth());
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/signup",
    payload: { name: "Studio do Miguel", email: "miguel@example.com", password: "senha12345" },
  });
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.equal(body.id, OWNER_ID);
  assert.equal(body.apiKey.name, "Chave padrão");
  assert.ok(body.apiKey.secret);

  const accessCookie = res.cookies.find((c) => c.name === "sb-access-token");
  assert.ok(accessCookie, "sets the access token cookie");
  assert.equal(accessCookie!.httpOnly, true);

  const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: cookieHeader(res) } });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(JSON.parse(me.body), { ownerId: OWNER_ID, email: FAKE_USER.email, name: "Studio do Miguel" });
});

test("auth/token hands back the raw JWT from the session cookie, for the Gerar screen's Edge Function call", async () => {
  const app = buildApp(makeDeps(), makeAuth());
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "miguel@example.com", password: "senha-certa" },
  });
  const withCookie = await app.inject({ method: "GET", url: "/api/v1/auth/token", headers: { cookie: cookieHeader(login) } });
  assert.equal(withCookie.statusCode, 200);
  assert.equal(JSON.parse(withCookie.body).accessToken, FAKE_SESSION.access_token);

  const withoutCookie = await app.inject({ method: "GET", url: "/api/v1/auth/token" });
  assert.equal(withoutCookie.statusCode, 401);
});

test("signup 400s when a required field is missing", async () => {
  const app = buildApp(makeDeps(), makeAuth());
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload: { name: "X", email: "x@example.com" } });
  assert.equal(res.statusCode, 400);
});

// --- login / logout --------------------------------------------------------------

test("login sets the session cookie on correct credentials, 401s otherwise", async () => {
  const app = buildApp(makeDeps(), makeAuth());
  const ok = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "miguel@example.com", password: "senha-certa" },
  });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.cookies.some((c) => c.name === "sb-access-token"));

  const wrong = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "miguel@example.com", password: "senha-errada" },
  });
  assert.equal(wrong.statusCode, 401);
});

test("logout tells the browser to delete both session cookies", async () => {
  // O access token em si é um JWT stateless — continua válido até expirar, mesmo depois do
  // logout (é assim que Supabase Auth funciona; revogar de verdade exigiria uma denylist, que
  // não existe aqui). O que "logout" garante é que o NAVEGADOR para de mandar o cookie —
  // por isso o teste verifica o Set-Cookie da resposta, não uma chamada seguinte com o
  // cookie antigo reenviado à mão (nenhum navegador real faria isso depois de um clear).
  const app = buildApp(makeDeps(), makeAuth());
  const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
  assert.equal(logout.statusCode, 204);

  const access = logout.cookies.find((c) => c.name === "sb-access-token");
  const refresh = logout.cookies.find((c) => c.name === "sb-refresh-token");
  assert.ok(access && refresh, "logout sets clearing Set-Cookie headers for both cookies");
  assert.equal(access!.value, "");
  assert.equal(refresh!.value, "");
});

// --- rotas de template/chave: sessão de cookie E chave de API resolvem pro mesmo owner --------

test("a cookie session can list/create templates without any API key", async () => {
  const app = buildApp(makeDeps(), makeAuth());
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "miguel@example.com", password: "senha-certa" },
  });
  const cookie = cookieHeader(login);

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/templates",
    headers: { cookie },
    payload: { name: "Via sessão", document: { active: 0, pages: [] } },
  });
  assert.equal(created.statusCode, 201);

  const list = await app.inject({ method: "GET", url: "/api/v1/templates", headers: { cookie } });
  assert.deepEqual(JSON.parse(list.body).map((t: { name: string }) => t.name), ["Via sessão"]);
});

test("a Supabase JWT passed as Bearer (the Edge Function path) resolves the same owner as the cookie", async () => {
  const app = buildApp(makeDeps(), makeAuth());
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/templates",
    headers: { authorization: `Bearer ${FAKE_SESSION.access_token}` },
  });
  assert.equal(res.statusCode, 200);
});

test("an authenticated editor can approve the exact submitted version and unlock downloads", async () => {
  const app = buildApp(makeDeps(), makeAuth(), { client: makeFakeStorageClient() });
  const headers = { authorization: `Bearer ${FAKE_SESSION.access_token}` };
  const source = await app.inject({
    method: "POST", url: "/api/v1/templates", headers,
    payload: { name: "Card", document: { name: "Card", active: 0, pages: [{ id: "p1", w: 100, h: 100, bg: "#000", els: [] }] } },
  });
  const sourceId = JSON.parse(source.body).id;
  const generated = await app.inject({
    method: "POST", url: "/api/v1/generations",
    headers: { ...headers, "idempotency-key": "review-1" },
    payload: { template: sourceId, name: "Gerado", pages: [{ layers: {} }] },
  });
  assert.equal(generated.statusCode, 201);
  const generatedBody = JSON.parse(generated.body);
  const generationId = generatedBody.generation.id;
  const designId = generatedBody.design.id;

  const beforeApproval = await app.inject({ method: "GET", url: `/api/v1/templates/${designId}`, headers });
  assert.equal("downloadUrl" in JSON.parse(beforeApproval.body), false);

  const approved = await app.inject({
    method: "POST", url: `/api/v1/generations/${generationId}/approve`, headers,
    payload: { version: 1 },
  });
  assert.equal(approved.statusCode, 200);
  const body = JSON.parse(approved.body);
  assert.equal(body.generation.reviewStatus, "approved");
  assert.equal(body.generation.canDownload, true);
  assert.match(body.design.pages[0].pngUrl, /\/renders\/approved\/.*\/versions\/1\/page-1\.png$/);
  const afterApproval = await app.inject({ method: "GET", url: `/api/v1/templates/${designId}`, headers });
  assert.match(JSON.parse(afterApproval.body).downloadUrl, /\/renders\/approved\/.*\/versions\/1\/page-1\.png$/);

  const replay = await app.inject({
    method: "POST", url: `/api/v1/generations/${generationId}/approve`, headers,
    payload: { version: 1 },
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(JSON.parse(replay.body).generation.approvedVersion, 1);
});

test("editing after submission blocks stale approval until the editor submits a new version", async () => {
  const sourceDoc = { name: "Card", active: 0, pages: [{ id: "p1", w: 100, h: 100, bg: "#000", els: [
    { id: "title", type: "text", name: "titulo", text: "Original" },
  ] }] };
  const rows = new Map<string, TemplateRow>([["source", { id: "source", ownerId: OWNER_ID, kind: "custom", name: "Card", document: sourceDoc, favorite: false }]]);
  const deps = makeDeps({
    findTemplate: async (ownerId, id) => rows.get(id)?.ownerId === ownerId ? rows.get(id)! : null,
    createTemplate: async (ownerId, input) => {
      const row = { id: input.id!, ownerId, kind: "custom", name: input.name, document: input.document, favorite: false };
      rows.set(row.id, row);
      return row;
    },
    updateTemplate: async (ownerId, id, input) => {
      const row = rows.get(id);
      if (!row || row.ownerId !== ownerId) return null;
      const updated = { ...row, name: input.name ?? row.name, document: input.document ?? row.document };
      rows.set(id, updated);
      return updated;
    },
  });
  const app = buildApp(deps, makeAuth(), { client: makeFakeStorageClient() });
  const headers = { authorization: `Bearer ${FAKE_SESSION.access_token}` };
  const created = await app.inject({
    method: "POST", url: "/api/v1/generations", headers: { ...headers, "idempotency-key": "stale-review" },
    payload: { template: "source", name: "Gerado", pages: [{ layers: { titulo: { text: "Versão 1" } } }] },
  });
  const payload = JSON.parse(created.body);
  const generationId = payload.generation.id;
  const designId = payload.design.id;
  const changed = structuredClone(rows.get(designId)!.document) as typeof sourceDoc;
  changed.pages[0].els[0].text = "Versão 2";
  await app.inject({ method: "PUT", url: `/api/v1/templates/${designId}`, headers, payload: { document: changed } });

  const stale = await app.inject({
    method: "POST", url: `/api/v1/generations/${generationId}/approve`, headers, payload: { version: 1 },
  });
  assert.equal(stale.statusCode, 409);

  const submitted = await app.inject({ method: "POST", url: `/api/v1/generations/${generationId}/submit`, headers });
  assert.equal(JSON.parse(submitted.body).generation.version, 2);
  const approved = await app.inject({
    method: "POST", url: `/api/v1/generations/${generationId}/approve`, headers, payload: { version: 2 },
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(JSON.parse(approved.body).generation.approvedVersion, 2);
});

test("an API key can create a generation but cannot approve it", async () => {
  const generatedDesign = { name: "Card", active: 0, pages: [{ id: "p1", w: 100, h: 100, bg: "#000", els: [] }] };
  const rows = new Map<string, TemplateRow>([["source", { id: "source", ownerId: OWNER_ID, kind: "custom", name: "Card", document: generatedDesign, favorite: false }]]);
  const deps = makeDeps({
    findApiKeyOwner: async () => ({ ownerId: OWNER_ID }),
    findTemplate: async (ownerId, id) => rows.get(id)?.ownerId === ownerId ? rows.get(id)! : null,
    createTemplate: async (ownerId, input) => {
      const row = { id: input.id!, ownerId, kind: "custom", name: input.name, document: input.document, favorite: false };
      rows.set(row.id, row);
      return row;
    },
  });
  const app = buildApp(deps, makeAuth(), { client: makeFakeStorageClient() });
  const headers = { authorization: "Bearer blk_live_automation", "idempotency-key": "api-key-review" };
  const created = await app.inject({
    method: "POST", url: "/api/v1/generations", headers,
    payload: { template: "source", name: "Gerado", pages: [{ layers: {} }] },
  });
  const generationId = JSON.parse(created.body).generation.id;
  const approval = await app.inject({
    method: "POST", url: `/api/v1/generations/${generationId}/approve`,
    headers: { authorization: headers.authorization }, payload: { version: 1 },
  });
  assert.equal(approval.statusCode, 403);
});

test("template/key routes still 401 with no cookie and no Authorization header, even with auth configured", async () => {
  const app = buildApp(makeDeps(), makeAuth());
  const res = await app.inject({ method: "GET", url: "/api/v1/templates" });
  assert.equal(res.statusCode, 401);
});
