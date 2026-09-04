import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, createMemoryGenerationRepository, hashJson } from "./generationWorkflow.ts";

test("idempotency hashes do not depend on object key order", () => {
  assert.equal(
    hashJson({ template: "x", pages: [{ layers: { titulo: { text: "Oi" }, corpo: { text: "Texto" } } }] }),
    hashJson({ pages: [{ layers: { corpo: { text: "Texto" }, titulo: { text: "Oi" } } }], template: "x" }),
  );
  assert.notEqual(hashJson({ value: 1 }), hashJson({ value: 2 }));
  assert.equal(canonicalJson([3, { b: 2, a: 1 }]), '[3,{"a":1,"b":2}]');
});

test("editing an approved generation creates a draft without erasing the approved version", async () => {
  const repository = createMemoryGenerationRepository();
  const created = await repository.createWithInitialVersion({
    id: "gen-1", ownerId: "owner-1", designId: "design-1", sourceTemplateId: "source-1",
    idempotencyKey: "run-1", requestHash: "request", document: { pages: [] }, documentChecksum: "v1",
  });
  await repository.recordDecision({
    ownerId: created.ownerId, generationId: created.id, version: 1, action: "approved", actorId: created.ownerId,
  });
  const edited = await repository.markEdited(created.ownerId, created.designId);
  assert.equal(edited?.reviewStatus, "draft");
  assert.equal(edited?.deliveryStatus, "blocked");
  assert.equal(edited?.approvedVersion, 1);
});

test("resubmitting unchanged content reuses a version; changed content creates the next version", async () => {
  const repository = createMemoryGenerationRepository();
  await repository.createWithInitialVersion({
    id: "gen-1", ownerId: "owner-1", designId: "design-1", sourceTemplateId: "source-1",
    idempotencyKey: "run-1", requestHash: "request", document: { title: "v1" }, documentChecksum: "v1",
  });
  const same = await repository.submitVersion({
    ownerId: "owner-1", generationId: "gen-1", document: { title: "v1" }, documentChecksum: "v1", createdBy: "owner-1",
  });
  const changed = await repository.submitVersion({
    ownerId: "owner-1", generationId: "gen-1", document: { title: "v2" }, documentChecksum: "v2", createdBy: "owner-1",
  });
  assert.equal(same.version.version, 1);
  assert.equal(changed.version.version, 2);
  assert.equal(changed.generation.reviewStatus, "pending");
});
