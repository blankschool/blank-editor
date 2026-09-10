import { test } from "node:test";
import assert from "node:assert/strict";
import { syncTemplateToServer } from "./templateStore.ts";
import type { Doc } from "./types.ts";

const doc = (): Doc => ({ name: "d", active: 0, pages: [], seedId: "abc" } as Doc);

async function withFetch<T>(reply: () => Response | Promise<Response> | never, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => reply()) as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = previous; }
}

test("a design deleted on the server reports gone, not a generic failure", async () => {
  const result = await withFetch(() => new Response("", { status: 404 }), () => syncTemplateToServer(doc()));
  assert.equal(result, "gone");
});

test("a server or network fault stays retryable", async () => {
  assert.equal(await withFetch(() => new Response("", { status: 500 }), () => syncTemplateToServer(doc())), "failed");
  assert.equal(await withFetch(() => { throw new Error("offline"); }, () => syncTemplateToServer(doc())), "failed");
});

test("a successful write reports saved", async () => {
  const result = await withFetch(() => new Response("{}", { status: 200 }), () => syncTemplateToServer(doc()));
  assert.equal(result, "saved");
});

test("a document that was never created on the server has nothing to sync", async () => {
  const result = await withFetch(() => { throw new Error("must not be called"); }, () => syncTemplateToServer({ name: "d", active: 0, pages: [] } as Doc));
  assert.equal(result, "saved");
});
