import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp, type AppDeps } from "./app.ts";
import { hashApiKey } from "./auth.ts";

const VALID_KEY = "blk_live_test";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // just needs to be *a* buffer for these tests

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    findApiKeyOwner: async (keyHash) =>
      keyHash === hashApiKey(VALID_KEY) ? { id: "owner-1", name: "test key" } : null,
    findTemplate: async (id) => (id === "tpl-1" ? { id: "tpl-1", kind: "tweet", name: "Tweet" } : null),
    renderTweetPng: async () => PNG_BYTES,
    ...overrides,
  };
}

const validBody = {
  template: "tpl-1",
  layers: {
    avatar: { image_url: "https://example.com/a.jpg" },
    displayName: { text: "Micael Crasto" },
    handle: { text: "@MicaelCrasto" },
    tweetText: { text: "hello" },
  },
};

test("rejects a request with no Authorization header", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({ method: "POST", url: "/api/v1/render", payload: validBody });
  assert.equal(res.statusCode, 401);
});

test("rejects a request with an unknown API key", async () => {
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

test("400s when a required layer is missing", async () => {
  const app = buildApp(makeDeps());
  const { avatar, ...layersWithoutAvatar } = validBody.layers;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/render",
    headers: { authorization: `Bearer ${VALID_KEY}` },
    payload: { template: "tpl-1", layers: layersWithoutAvatar },
  });
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error, /avatar/);
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

test("passes the mapped layer values through to renderTweetPng", async () => {
  let received: unknown;
  const app = buildApp(
    makeDeps({
      renderTweetPng: async (input) => {
        received = input;
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
    avatarUrl: "https://example.com/a.jpg",
    displayName: "Micael Crasto",
    handle: "@MicaelCrasto",
    tweetText: "hello",
  });
});
