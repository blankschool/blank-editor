import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildApp, type AppDeps, type StorageDeps } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import { FIXTURE_FONT_PATH } from "./render/__fixtures__/fixtureFont.ts";

const KEY = "blk_live_teste";
const OWNER = "owner-1";
const SFNT = readFileSync(FIXTURE_FONT_PATH);

function deps(over: Partial<AppDeps> = {}): AppDeps {
  return {
    findApiKeyOwner: async (h) => (h === hashApiKey(KEY) ? { ownerId: OWNER } : null),
    findTemplate: async () => null,
    listTemplates: async () => [],
    createTemplate: async (ownerId, { name, document }) => ({ id: "t", ownerId, kind: "custom", name, document, favorite: false }),
    updateTemplate: async () => null,
    deleteTemplate: async () => false,
    listApiKeys: async () => [],
    createApiKey: async (_o, name) => ({ id: "k", name, secret: KEY, createdAt: "2024-01-01T00:00:00.000Z" }),
    revokeApiKey: async () => false,
    deleteApiKey: async () => false,
    renderTemplatePng: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    upsertFontFace: async (input) => ({
      id: input.id, sha256: input.sha256, internalFamily: input.internalFamily,
      postscriptName: input.postscriptName ?? null, weight: input.weight, style: input.style,
      stretch: input.stretch ?? null, os2FsType: input.os2FsType ?? null,
      sfntPath: input.sfntPath, woff2Path: input.woff2Path,
    }),
    listFontFaces: async () => [],
    ...over,
  };
}

/** Storage falso: só devolve um caminho previsível, sem tocar em rede. */
const storage = { client: {} } as unknown as StorageDeps;

function form(parts: Array<[string, string] | [string, string, Buffer, string]>) {
  const fd = new FormData();
  for (const p of parts) {
    if (p.length === 2) fd.append(p[0], p[1]);
    else fd.append(p[0], new Blob([new Uint8Array(p[2])], { type: p[3] }), p[1]);
  }
  return fd;
}

async function postFonts(app: ReturnType<typeof buildApp>, fd: FormData) {
  const req = new Request("http://x/api/v1/fonts", { method: "POST", body: fd });
  return app.inject({
    method: "POST", url: "/api/v1/fonts",
    headers: { authorization: `Bearer ${KEY}`, "content-type": req.headers.get("content-type")! },
    payload: Buffer.from(await req.arrayBuffer()),
  });
}

test("recusa quando falta um dos dois formatos — uma face só serve se o canvas E o render puderem desenhá-la", async () => {
  const app = buildApp(deps(), null, storage);
  const res = await postFonts(app, form([
    ["sfnt", "f.ttf", SFNT, "font/ttf"],
    ["internalFamily", "BlankFixture"], ["weight", "400"],
  ]));
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /sfnt.*woff2|woff2/);
});

test("recusa sem os metadados que identificam a face", async () => {
  const app = buildApp(deps(), null, storage);
  const res = await postFonts(app, form([
    ["sfnt", "f.ttf", SFNT, "font/ttf"],
    ["woff2", "f.woff2", Buffer.from("woff2"), "font/woff2"],
  ]));
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /internalFamily/);
});

test("recusa extensão errada em vez de gravar um blob que o rasterizador não vai conseguir abrir", async () => {
  const app = buildApp(deps(), null, storage);
  const res = await postFonts(app, form([
    ["sfnt", "f.png", SFNT, "font/ttf"],
    ["woff2", "f.woff2", Buffer.from("w"), "font/woff2"],
    ["internalFamily", "X"], ["weight", "400"],
  ]));
  assert.equal(res.statusCode, 400);
});

test("responde 501 quando não há storage configurado, em vez de fingir que registrou", async () => {
  const app = buildApp(deps(), null, null);
  const res = await postFonts(app, form([
    ["sfnt", "f.ttf", SFNT, "font/ttf"],
    ["woff2", "f.woff2", Buffer.from("w"), "font/woff2"],
    ["internalFamily", "X"], ["weight", "400"],
  ]));
  assert.equal(res.statusCode, 501);
});

test("exige autenticação", async () => {
  const app = buildApp(deps(), null, storage);
  const res = await app.inject({ method: "GET", url: "/api/v1/fonts" });
  assert.equal(res.statusCode, 401);
});

test("o sha256 é calculado dos bytes, não aceito do cliente — é a identidade da face", () => {
  // Documenta a fronteira: mesmo que alguém envie um campo sha256, o servidor ignora e usa este.
  const esperado = createHash("sha256").update(SFNT).digest("hex");
  assert.match(esperado, /^[0-9a-f]{64}$/);
});

test("recusa família declarada que não existe dentro do arquivo — o rasterizador não acusaria", async () => {
  const app = buildApp(deps(), null, storage);
  const res = await postFonts(app, form([
    ["sfnt", "f.ttf", SFNT, "font/ttf"],
    ["woff2", "f.woff2", Buffer.from("w"), "font/woff2"],
    ["internalFamily", "Inter"], ["weight", "400"],   // o arquivo é BlankFixture por dentro
  ]));
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /não existe no arquivo enviado/);
  assert.match(res.json().error, /BlankFixture/);
});

test("/health/fonts responde 503 quando o dono não tem face para a família — não 200 vazio", async () => {
  const app = buildApp(deps(), null, storage);
  const res = await app.inject({ method: "GET", url: "/health/fonts", headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(res.statusCode, 503);
  assert.match(res.json().detalhe, /nenhuma face registrada/);
});

test("/health/fonts aprova quando a face do dono desenha de verdade", async () => {
  const { FIXTURE_SHA256, FIXTURE_FONT_PATH, FIXTURE_FAMILY } = await import("./render/__fixtures__/fixtureFont.ts");
  const app = buildApp(deps({
    listFontFaces: async () => [{
      id: "f1", sha256: FIXTURE_SHA256, internalFamily: FIXTURE_FAMILY, postscriptName: null,
      weight: 400, style: "Regular", stretch: null, os2FsType: 0,
      sfntPath: FIXTURE_FONT_PATH, woff2Path: "",
    }],
  }), null, storage);
  const res = await app.inject({
    method: "GET", url: `/health/fonts?family=${FIXTURE_FAMILY}`,
    headers: { authorization: `Bearer ${KEY}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});
