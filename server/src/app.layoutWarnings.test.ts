import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp, type AppDeps, type QualityDeps } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import type { TemplateRow } from "./db.ts";

const VALID_KEY = "blk_live_test";
const OWNER_ID = "owner-1";
const AUTH = { authorization: `Bearer ${VALID_KEY}` };
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Documento com duas linhas quase sobrepostas mas com ângulos bem diferentes — o mesmo caso
 *  que src/render/visualQualityGate.test.ts usa para "duplicate_crooked_shape". */
const DOCUMENT_WITH_LAYOUT_DEFECT = {
  active: 0,
  pages: [
    {
      w: 1080,
      h: 1350,
      bg: "#fff",
      els: [
        { id: "a", type: "line", x: 60, y: 819, w: 830, h: 3, rot: 356 },
        { id: "b", type: "line", x: 60, y: 819, w: 830, h: 3, rot: 350 },
      ],
    },
  ],
};

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    findApiKeyOwner: async (keyHash) => (keyHash === hashApiKey(VALID_KEY) ? { ownerId: OWNER_ID } : null),
    findTemplate: async () => null,
    listTemplates: async () => [],
    createTemplate: async (ownerId, { id, name, document }): Promise<TemplateRow> => ({
      id: id ?? "new-tpl", ownerId, kind: "custom", name, document, favorite: false,
    }),
    updateTemplate: async (ownerId, id, input) => ({
      id, ownerId, kind: "custom", name: input.name ?? "Template", document: input.document ?? {}, favorite: input.favorite ?? false,
    }),
    deleteTemplate: async () => false,
    listApiKeys: async () => [],
    createApiKey: async (ownerId, name) => ({ id: "new-key", name, secret: "blk_live_generated", createdAt: "2024-01-01T00:00:00.000Z" }),
    revokeApiKey: async () => false,
    deleteApiKey: async () => false,
    renderTemplatePng: async () => PNG_BYTES,
    upsertFontFace: async (input) => ({
      id: input.id, sha256: input.sha256, internalFamily: input.internalFamily,
      postscriptName: input.postscriptName ?? null, weight: input.weight, style: input.style,
      stretch: input.stretch ?? null, os2FsType: input.os2FsType ?? null,
      sfntPath: input.sfntPath, woff2Path: input.woff2Path,
    }),
    listFontFaces: async () => [],
    ...overrides,
  };
}

/** Cliente fake e determinístico: sempre responde "defeito grave" pra qualquer pergunta de
 *  duplicata torta que o gate fizer — não precisa de rede nem de credencial de verdade. */
function fakeJevAlwaysFlags(): QualityDeps["jev"] {
  return {
    async ask(_state, questions) {
      const answers: Record<string, { noul?: number; score?: number }> = {};
      for (const key of Object.keys(questions)) {
        if (key.startsWith("linha_duplicada_")) answers[key] = { noul: 0.95 };
        if (key.startsWith("estouro_")) answers[key] = { score: 1.9 };
      }
      return answers;
    },
  };
}

test("POST /api/v1/templates includes layoutWarnings when the quality dep flags a defect", async () => {
  const app = buildApp(makeDeps(), null, null, null, null, null, { jev: fakeJevAlwaysFlags() });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/templates",
    headers: AUTH,
    payload: { name: "Com defeito", document: DOCUMENT_WITH_LAYOUT_DEFECT },
  });
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.layoutWarnings) && body.layoutWarnings.length > 0);
  assert.equal(body.layoutWarnings[0].page, 1);
  assert.deepEqual(body.layoutWarnings[0].elementIds.sort(), ["a", "b"]);
  assert.ok(["low", "medium", "high"].includes(body.layoutWarnings[0].severity));
  // Nenhum vestígio de fornecedor ou probabilidade crua no corpo público da resposta.
  const raw = res.body;
  assert.ok(!/jev/i.test(raw));
  assert.ok(!/typesafe/i.test(raw));
  assert.ok(!("probability" in body.layoutWarnings[0]));
});

test("POST /api/v1/templates has no layoutWarnings field when the quality dep is not configured", async () => {
  const app = buildApp(makeDeps());
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/templates",
    headers: AUTH,
    payload: { name: "Sem checagem", document: DOCUMENT_WITH_LAYOUT_DEFECT },
  });
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.equal(body.layoutWarnings, undefined);
});

test("PUT /api/v1/templates/:id includes layoutWarnings when document changes and a defect is flagged", async () => {
  const existing: TemplateRow = {
    id: "tpl-1", ownerId: OWNER_ID, kind: "custom", name: "Existente", favorite: false,
    document: { active: 0, pages: [{ w: 1080, h: 1350, bg: "#fff", els: [] }] },
  };
  const app = buildApp(
    makeDeps({
      findTemplate: async (ownerId, id) => (id === existing.id && ownerId === OWNER_ID ? existing : null),
      updateTemplate: async (ownerId, id, input) =>
        id === existing.id && ownerId === OWNER_ID ? { ...existing, ...input } : null,
    }),
    null, null, null, null, null, { jev: fakeJevAlwaysFlags() },
  );
  const res = await app.inject({
    method: "PUT",
    url: `/api/v1/templates/${existing.id}`,
    headers: AUTH,
    payload: { document: DOCUMENT_WITH_LAYOUT_DEFECT },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.layoutWarnings) && body.layoutWarnings.length > 0);
});

test("checkLayoutWarnings never fails the request when the Jev client throws", async () => {
  const throwingJev: QualityDeps["jev"] = { ask: async () => { throw new Error("network down"); } };
  const app = buildApp(makeDeps(), null, null, null, null, null, { jev: throwingJev });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/templates",
    headers: AUTH,
    payload: { name: "Com defeito", document: DOCUMENT_WITH_LAYOUT_DEFECT },
  });
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.equal(body.layoutWarnings, undefined);
});
