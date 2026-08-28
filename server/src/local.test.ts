import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.ts";
import { createLocalDeps } from "./local.ts";

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
    headers: { authorization: "Bearer blk_local_test" },
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

  const created = await app.inject({ method: "POST", url: "/api/v1/keys", payload: { name: "n8n" } });
  const { id, secret } = JSON.parse(created.body);

  const rendered = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: { authorization: `Bearer ${secret}` },
    payload: body,
  });
  assert.equal(rendered.statusCode, 200);

  await app.inject({ method: "DELETE", url: `/api/v1/keys/${id}` });

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
  const created = await app.inject({ method: "POST", url: "/api/v1/templates", payload: { name: "Novo", document } });
  const { id } = JSON.parse(created.body);

  const list = await app.inject({ method: "GET", url: "/api/v1/templates" });
  assert.ok(JSON.parse(list.body).some((t: { id: string }) => t.id === id));

  const rendered = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: { authorization: "Bearer blk_local_test" },
    payload: { template: id, layers: {} },
  });
  assert.equal(rendered.statusCode, 200);
});

test("DELETE /api/v1/templates/:id removes it from the list", async () => {
  const app = buildApp(createLocalDeps("blk_local_test", async () => Buffer.from("png")));
  const document = { active: 0, pages: [{ w: 100, h: 100, bg: "#000", els: [] }] };
  const created = await app.inject({ method: "POST", url: "/api/v1/templates", payload: { name: "Descartável", document } });
  const { id } = JSON.parse(created.body);

  const deleted = await app.inject({ method: "DELETE", url: `/api/v1/templates/${id}` });
  assert.equal(deleted.statusCode, 204);

  const list = await app.inject({ method: "GET", url: "/api/v1/templates" });
  assert.ok(!JSON.parse(list.body).some((t: { id: string }) => t.id === id));
});

test("a key can only be purged (permanently removed) after being revoked", async () => {
  const app = buildApp(createLocalDeps("blk_local_test", async () => Buffer.from("png")));
  const created = await app.inject({ method: "POST", url: "/api/v1/keys", payload: { name: "descartável" } });
  const { id } = JSON.parse(created.body);

  const tooEarly = await app.inject({ method: "DELETE", url: `/api/v1/keys/${id}/purge` });
  assert.equal(tooEarly.statusCode, 404);

  await app.inject({ method: "DELETE", url: `/api/v1/keys/${id}` });
  const purged = await app.inject({ method: "DELETE", url: `/api/v1/keys/${id}/purge` });
  assert.equal(purged.statusCode, 204);

  const list = await app.inject({ method: "GET", url: "/api/v1/keys" });
  assert.ok(!JSON.parse(list.body).some((k: { id: string }) => k.id === id));
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
