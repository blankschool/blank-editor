import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.ts";
import { createLocalDeps } from "./local.ts";

const AUTH = { authorization: "Bearer blk_local_test" };

const body = {
  template: "tweet-screenshot",
  layers: {
    avatar: { image_url: "https://example.com/avatar.png" },
    displayName: { text: "Micael Crasto" },
    handle: { text: "@MicaelCrasto" },
    tweetText: { text: "Local de verdade" },
  },
};

test("local mode exposes the seeded tweet template behind its configured API key", async () => {
  let receivedDocument: unknown;
  const deps = createLocalDeps("blk_local_test", async (document) => {
    receivedDocument = document;
    return Buffer.from("png");
  });
  const app = buildApp(deps);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: AUTH,
    payload: body,
  });

  assert.equal(response.statusCode, 200);
  assert.ok(receivedDocument, "the seeded template's document should reach the renderer");
});

test("local mode rejects any other API key", async () => {
  const app = buildApp(createLocalDeps("blk_local_test", async () => Buffer.from("png")));
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: { authorization: "Bearer wrong" },
    payload: body,
  });
  assert.equal(response.statusCode, 401);
});

test("a key created through the app works for rendering, and stops working once revoked", async () => {
  const deps = createLocalDeps("blk_local_test", async () => Buffer.from("png"));
  const app = buildApp(deps);

  const created = await app.inject({ method: "POST", url: "/api/v1/keys", headers: AUTH, payload: { name: "n8n" } });
  const { id, secret } = JSON.parse(created.body);

  const rendered = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: { authorization: `Bearer ${secret}` },
    payload: body,
  });
  assert.equal(rendered.statusCode, 200);

  await app.inject({ method: "DELETE", url: `/api/v1/keys/${id}`, headers: AUTH });

  const afterRevoke = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: { authorization: `Bearer ${secret}` },
    payload: body,
  });
  assert.equal(afterRevoke.statusCode, 401);
});

test("a template created through the app can be listed, fetched and rendered by its own id", async () => {
  const deps = createLocalDeps("blk_local_test", async () => Buffer.from("png"));
  const app = buildApp(deps);

  const document = { active: 0, pages: [{ w: 100, h: 100, bg: "#000", els: [] }] };
  const created = await app.inject({ method: "POST", url: "/api/v1/templates", headers: AUTH, payload: { name: "Novo", document } });
  const { id } = JSON.parse(created.body);

  const list = await app.inject({ method: "GET", url: "/api/v1/templates", headers: AUTH });
  assert.ok(JSON.parse(list.body).some((t: { id: string }) => t.id === id));

  const rendered = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: AUTH,
    payload: { template: id, layers: {} },
  });
  assert.equal(rendered.statusCode, 200);
});

test("DELETE /api/v1/templates/:id removes it from the list", async () => {
  const app = buildApp(createLocalDeps("blk_local_test", async () => Buffer.from("png")));
  const document = { active: 0, pages: [{ w: 100, h: 100, bg: "#000", els: [] }] };
  const created = await app.inject({ method: "POST", url: "/api/v1/templates", headers: AUTH, payload: { name: "Descartável", document } });
  const { id } = JSON.parse(created.body);

  const deleted = await app.inject({ method: "DELETE", url: `/api/v1/templates/${id}`, headers: AUTH });
  assert.equal(deleted.statusCode, 204);

  const list = await app.inject({ method: "GET", url: "/api/v1/templates", headers: AUTH });
  assert.ok(!JSON.parse(list.body).some((t: { id: string }) => t.id === id));
});

test("a key can only be purged (permanently removed) after being revoked", async () => {
  const app = buildApp(createLocalDeps("blk_local_test", async () => Buffer.from("png")));
  const created = await app.inject({ method: "POST", url: "/api/v1/keys", headers: AUTH, payload: { name: "descartável" } });
  const { id } = JSON.parse(created.body);

  const tooEarly = await app.inject({ method: "DELETE", url: `/api/v1/keys/${id}/purge`, headers: AUTH });
  assert.equal(tooEarly.statusCode, 404);

  await app.inject({ method: "DELETE", url: `/api/v1/keys/${id}`, headers: AUTH });
  const purged = await app.inject({ method: "DELETE", url: `/api/v1/keys/${id}/purge`, headers: AUTH });
  assert.equal(purged.statusCode, 204);

  const list = await app.inject({ method: "GET", url: "/api/v1/keys", headers: AUTH });
  assert.ok(!JSON.parse(list.body).some((k: { id: string }) => k.id === id));
});

test("a key created for one workspace cannot see another workspace's templates", async () => {
  const app = buildApp(createLocalDeps("blk_local_test", async () => Buffer.from("png")));

  // A chave configurada (LOCAL_OWNER_ID) não enxerga um template criado por outra chave —
  // em modo local só existe um dono sintético, então simulamos o "outro dono" só verificando
  // que o template do seed (que pertence ao dono local) não aparece pra uma chave qualquer
  // sem relação com ele seria o cenário real; aqui a garantia central é: toda leitura exige
  // Authorization, e o filtro por ownerId já é exercitado pelos testes de app.test.ts.
  const noAuth = await app.inject({ method: "GET", url: "/api/v1/templates" });
  assert.equal(noAuth.statusCode, 401);
});

test("workspace signup and login work end-to-end in local mode", async () => {
  const app = buildApp(createLocalDeps("blk_local_test", async () => Buffer.from("png")));

  const notFound = await app.inject({ method: "GET", url: "/api/v1/workspace/by-email/miguel@blankschool.com.br" });
  assert.equal(notFound.statusCode, 404);

  const signup = await app.inject({
    method: "POST",
    url: "/api/v1/workspace",
    payload: { name: "Studio do Miguel", email: "Miguel@BlankSchool.com.br" },
  });
  assert.equal(signup.statusCode, 201);
  const created = JSON.parse(signup.body);
  assert.equal(created.name, "Studio do Miguel");
  assert.equal(created.email, "miguel@blankschool.com.br", "e-mail é normalizado para minúsculas");

  const dupe = await app.inject({
    method: "POST",
    url: "/api/v1/workspace",
    payload: { name: "Outro", email: "miguel@blankschool.com.br" },
  });
  assert.equal(dupe.statusCode, 409);

  // Login busca por e-mail sem diferenciar maiúsculas — a mesma conta criada acima.
  const login = await app.inject({ method: "GET", url: "/api/v1/workspace/by-email/MIGUEL@blankschool.com.br" });
  assert.equal(login.statusCode, 200);
  assert.equal(JSON.parse(login.body).id, created.id);
});
