import { randomUUID } from "node:crypto";
import { hashApiKey } from "./auth.ts";
import type { AppDeps } from "./app.ts";
import type { ApiKeySummary, DesignVersionRow, FontFaceRow, TemplateRow } from "./db.ts";

/** Dono sintético de tudo que existe em modo local — não há Supabase Auth aqui, só um id fixo. */
const LOCAL_OWNER_ID = "local-dev-owner";

const SEED_TEMPLATE: TemplateRow = {
  id: "tweet-screenshot",
  ownerId: LOCAL_OWNER_ID,
  kind: "tweet",
  name: "Tweet Hollywood creators",
  favorite: false,
  document: {
    name: "Tweet Hollywood creators",
    active: 0,
    pages: [{
      id: "tweet-page",
      w: 1080,
      h: 1350,
      bg: "#000000",
      els: [
        { id: "avatar-field", type: "image", name: "avatar", x: 72, y: 64, w: 96, h: 96, radius: 48, src: "" },
        { id: "displayName-field", type: "text", name: "displayName", x: 188, y: 66, w: 820, h: 40, text: "Micael Crasto", font: "Inter", size: 34, weight: 700, align: "left", lh: 1.25, fill: "#E6E9EA" },
        { id: "handle-field", type: "text", name: "handle", x: 188, y: 110, w: 820, h: 34, text: "@MicaelCrasto", font: "Inter", size: 28, weight: 400, align: "left", lh: 1.25, fill: "#71757A" },
        { id: "tweetText-field", type: "text", name: "tweetText", x: 72, y: 192, w: 936, h: 290, text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n\nUt enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.", font: "Inter", size: 34, weight: 400, align: "left", lh: 1.4, fill: "#E6E9EA" },
        { id: "media-field", type: "image", name: "media", x: 72, y: 506, w: 936, h: 620, radius: 24, src: "" },
      ],
    }],
  },
};

interface StoredApiKey extends ApiKeySummary {
  keyHash: string;
  ownerId: string;
}

/**
 * In-memory dependencies for local development: no Postgres, state lives only for the process's
 * lifetime, seeded with one template so the console has something to open on first run. The
 * configured `apiKey` always works (for curl/n8n during development) alongside any key created
 * through the app itself — todas as chaves criadas aqui pertencem ao mesmo LOCAL_OWNER_ID, já
 * que não existe Supabase Auth em modo local pra ter mais de uma conta de verdade.
 */
export function createLocalDeps(apiKey: string, renderTemplatePng: AppDeps["renderTemplatePng"]): AppDeps {
  const configuredHash = hashApiKey(apiKey);
  const templates = new Map<string, TemplateRow>([
    [SEED_TEMPLATE.id, SEED_TEMPLATE],
  ]);
  const apiKeys = new Map<string, StoredApiKey>();
  /** Faces por sha256: a mesma dedup que o `unique (owner_id, sha256)` do Postgres faz. */
  const fontFaces = new Map<string, FontFaceRow>();
  const designVersions = new Map<string, DesignVersionRow>();

  /**
   * Quando cada template foi tocado. Fica fora do TemplateRow porque a coluna
   * updated_at é do Postgres, não do documento; aqui é só o equivalente em
   * memória. Antes listTemplates devolvia `new Date(0)` para todo mundo, o que
   * fazia o console mostrar "editado há 56 anos" em dev — e sem data confiável
   * não há como julgar a home nem ordenar os recentes.
   */
  const touchedAt = new Map<string, string>();
  const touch = (id: string) => touchedAt.set(id, new Date().toISOString());
  const bootedAt = Date.now();
  touchedAt.set(SEED_TEMPLATE.id, new Date(bootedAt - 60_000).toISOString());

  return {
    findApiKeyOwner: async (keyHash) => {
      if (keyHash === configuredHash) return { ownerId: LOCAL_OWNER_ID };
      const owner = [...apiKeys.values()].find((k) => k.keyHash === keyHash && !k.revoked);
      return owner ? { ownerId: owner.ownerId } : null;
    },

    findTemplate: async (ownerId, id) => {
      const row = templates.get(id);
      return row && row.ownerId === ownerId ? row : null;
    },

    // Mais recente primeiro, igual ao `order by updated_at desc` do Postgres em
    // db.ts — a home mostra os últimos editados e as duas pontas têm que
    // concordar na ordem.
    listTemplates: async (ownerId) =>
      [...templates.values()]
        .filter((t) => t.ownerId === ownerId)
        .map((t) => ({ id: t.id, name: t.name, updatedAt: touchedAt.get(t.id) ?? new Date(bootedAt).toISOString(), favorite: t.favorite }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),

    createTemplate: async (ownerId, { id, name, document }) => {
      const row: TemplateRow = { id: id ?? randomUUID(), ownerId, kind: "custom", name, document, favorite: false };
      templates.set(row.id, row);
      touch(row.id);
      return row;
    },

    updateTemplate: async (ownerId, id, { name, document, favorite }) => {
      const existing = templates.get(id);
      if (!existing || existing.ownerId !== ownerId) return null;
      const updated: TemplateRow = {
        ...existing,
        name: name ?? existing.name,
        document: document !== undefined ? document : existing.document,
        favorite: favorite ?? existing.favorite,
      };
      templates.set(id, updated);
      touch(id);
      return updated;
    },

    deleteTemplate: async (ownerId, id) => {
      const existing = templates.get(id);
      if (!existing || existing.ownerId !== ownerId) return false;
      touchedAt.delete(id);
      return templates.delete(id);
    },

    listApiKeys: async (ownerId) =>
      [...apiKeys.values()]
        .filter((k) => k.ownerId === ownerId)
        .map(({ keyHash: _keyHash, ownerId: _ownerId, ...summary }) => summary),

    createApiKey: async (ownerId, name) => {
      const id = randomUUID();
      const secret = `blk_local_${randomUUID().replace(/-/g, "")}`;
      apiKeys.set(id, { id, name, createdAt: new Date().toISOString(), revoked: false, keyHash: hashApiKey(secret), ownerId });
      return { id, name, secret, createdAt: apiKeys.get(id)!.createdAt };
    },

    revokeApiKey: async (ownerId, id) => {
      const existing = apiKeys.get(id);
      if (!existing || existing.ownerId !== ownerId || existing.revoked) return false;
      apiKeys.set(id, { ...existing, revoked: true });
      return true;
    },

    deleteApiKey: async (ownerId, id) => {
      const existing = apiKeys.get(id);
      if (!existing || existing.ownerId !== ownerId || !existing.revoked) return false;
      return apiKeys.delete(id);
    },

    renderTemplatePng,

    upsertFontFace: async (input) => {
      const existente = fontFaces.get(input.sha256);
      if (existente) return { ...existente, sfntPath: input.sfntPath };
      const face: FontFaceRow = {
        id: input.id, sha256: input.sha256, internalFamily: input.internalFamily,
        postscriptName: input.postscriptName ?? null, weight: input.weight, style: input.style,
        stretch: input.stretch ?? null, os2FsType: input.os2FsType ?? null,
        sfntPath: input.sfntPath, woff2Path: input.woff2Path,
      };
      fontFaces.set(input.sha256, face);
      return face;
    },
    listFontFaces: async () => [...fontFaces.values()],

    // `.reverse()` da ordem de inserção do Map, não comparar `createdAt` — mesmo raciocínio de
    // app.test.ts: duas versões criadas no mesmo milissegundo empatariam numa comparação de
    // string de data, e o Map já preserva a ordem certa sem precisar disso.
    listDesignVersions: async (ownerId, templateId) =>
      [...designVersions.values()]
        .filter((v) => v.ownerId === ownerId && v.templateId === templateId)
        .reverse(),

    createDesignVersion: async (ownerId, { templateId, name, document }) => {
      const version: DesignVersionRow = {
        id: randomUUID(), ownerId, templateId, name,
        document: structuredClone(document), createdAt: new Date().toISOString(),
      };
      designVersions.set(version.id, version);
      return version;
    },

    findDesignVersion: async (ownerId, templateId, id) => {
      const v = designVersions.get(id);
      return v && v.ownerId === ownerId && v.templateId === templateId ? v : null;
    },

    deleteDesignVersion: async (ownerId, templateId, id) => {
      const v = designVersions.get(id);
      if (!v || v.ownerId !== ownerId || v.templateId !== templateId) return false;
      return designVersions.delete(id);
    },
  };
}
