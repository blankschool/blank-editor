import assert from "node:assert/strict";
import test from "node:test";
import { ensurePlaygroundApiKey } from "./playgroundApiKey.ts";

test("creates and persists a Playground key when an existing account has no key in this browser", async () => {
  const saved: Array<[string, string]> = [];
  let creates = 0;

  const secret = await ensurePlaygroundApiKey("owner-existing", {
    read: () => null,
    save: (ownerId, value) => saved.push([ownerId, value]),
    create: async () => {
      creates += 1;
      return "blk_generated_for_playground";
    },
  });

  assert.equal(secret, "blk_generated_for_playground");
  assert.equal(creates, 1);
  assert.deepEqual(saved, [["owner-existing", "blk_generated_for_playground"]]);
});

test("reuses the account key already persisted in this browser", async () => {
  let creates = 0;

  const secret = await ensurePlaygroundApiKey("owner-known", {
    read: () => "blk_cached",
    save: () => assert.fail("a cached key must not be written again"),
    create: async () => {
      creates += 1;
      return "blk_unexpected";
    },
  });

  assert.equal(secret, "blk_cached");
  assert.equal(creates, 0);
});
