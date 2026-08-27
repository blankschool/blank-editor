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

test("local mode exposes the fixed tweet template behind its configured API key", async () => {
  let received: unknown;
  const deps = createLocalDeps("blk_local_test", async (input) => {
    received = input;
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
  assert.deepEqual(received, {
    avatarUrl: "https://example.com/avatar.png",
    displayName: "Micael Crasto",
    handle: "@MicaelCrasto",
    tweetText: "Local de verdade",
  });
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
