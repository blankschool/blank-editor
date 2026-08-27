import { randomUUID } from "node:crypto";
import { hashApiKey } from "./auth.ts";
import type { AppDeps } from "./app.ts";
import type { ApiKeySummary, TemplateRow } from "./db.ts";

const SEED_TEMPLATE: TemplateRow = {
  id: "tweet-screenshot",
  kind: "tweet",
  name: "Twitter mínimo",
  document: {
    name: "Twitter mínimo",
    active: 0,
    pages: [{
      id: "tweet-page",
      w: 1080,
      h: 1350,
      bg: "#000000",
      els: [
        { id: "avatar-field", type: "image", name: "avatar", centerGroup: "card", x: 72, y: 140, w: 112, h: 112, radius: 56, src: "https://github.com/github.png" },
        { id: "displayName-field", type: "text", name: "displayName", centerGroup: "card", x: 204, y: 142, w: 804, h: 48, text: "Micael Crasto", font: "Inter", size: 40, weight: 700, align: "left", lh: 1.25, fill: "#E6E9EA" },
        { id: "handle-field", type: "text", name: "handle", centerGroup: "card", x: 204, y: 196, w: 804, h: 40, text: "@MicaelCrasto", font: "Inter", size: 34, weight: 400, align: "left", lh: 1.25, fill: "#71757A" },
        { id: "tweetText-field", type: "text", name: "tweetText", centerGroup: "card", x: 72, y: 320, w: 936, text: "Template local funcionando de verdade.", font: "Inter", size: 46, weight: 400, align: "left", lh: 1.4, fill: "#E6E9EA" },
      ],
    }],
  },
};

const SEED_TEMPLATE_WITH_PHOTO: TemplateRow = {
  id: "tweet-with-photo",
  kind: "tweet",
  name: "Twitter com foto",
  document: {
    name: "Twitter com foto",
    active: 0,
    pages: [{
      id: "tweet-page",
      w: 1080,
      h: 1350,
      bg: "#000000",
      els: [
        { id: "avatar-field", type: "image", name: "avatar", x: 72, y: 140, w: 112, h: 112, radius: 56, src: "https://github.com/github.png" },
        { id: "displayName-field", type: "text", name: "displayName", x: 204, y: 142, w: 804, h: 48, text: "Micael Crasto", font: "Inter", size: 40, weight: 700, align: "left", lh: 1.25, fill: "#E6E9EA" },
        { id: "handle-field", type: "text", name: "handle", x: 204, y: 196, w: 804, h: 40, text: "@MicaelCrasto", font: "Inter", size: 34, weight: 400, align: "left", lh: 1.25, fill: "#71757A" },
        { id: "tweetText-field", type: "text", name: "tweetText", x: 72, y: 280, w: 936, h: 220, text: "Template com foto funcionando de verdade.", font: "Inter", size: 42, weight: 400, align: "left", lh: 1.35, fill: "#E6E9EA" },
        { id: "media-field", type: "image", name: "media", x: 72, y: 540, w: 936, h: 740, radius: 24, src: "https://pbs.twimg.com/media/HQA6oNTXcAADMtI?format=jpg&name=900x900" },
      ],
    }],
  },
};

interface StoredApiKey extends ApiKeySummary {
  keyHash: string;
}

/**
 * In-memory dependencies for local development: no Postgres, state lives only for the process's
 * lifetime, seeded with one template so the console has something to open on first run. The
 * configured `apiKey` always works (for curl/n8n during development) alongside any key created
 * through the app itself.
 */
export function createLocalDeps(apiKey: string, renderTemplatePng: AppDeps["renderTemplatePng"]): AppDeps {
  const configuredHash = hashApiKey(apiKey);
  const templates = new Map<string, TemplateRow>([
    [SEED_TEMPLATE.id, SEED_TEMPLATE],
    [SEED_TEMPLATE_WITH_PHOTO.id, SEED_TEMPLATE_WITH_PHOTO],
  ]);
  const apiKeys = new Map<string, StoredApiKey>();

  return {
    findApiKeyOwner: async (keyHash) => {
      if (keyHash === configuredHash) return { id: "local", name: "local development" };
      const owner = [...apiKeys.values()].find((k) => k.keyHash === keyHash && !k.revoked);
      return owner ? { id: owner.id, name: owner.name } : null;
    },

    findTemplate: async (id) => templates.get(id) ?? null,

    listTemplates: async () =>
      [...templates.values()]
        .map((t) => ({ id: t.id, name: t.name, updatedAt: new Date(0).toISOString() }))
        .sort((a, b) => a.name.localeCompare(b.name)),

    createTemplate: async ({ name, document }) => {
      const row: TemplateRow = { id: randomUUID(), kind: "custom", name, document };
      templates.set(row.id, row);
      return row;
    },

    updateTemplate: async (id, { name, document }) => {
      const existing = templates.get(id);
      if (!existing) return null;
      const updated: TemplateRow = {
        ...existing,
        name: name ?? existing.name,
        document: document !== undefined ? document : existing.document,
      };
      templates.set(id, updated);
      return updated;
    },

    deleteTemplate: async (id) => templates.delete(id),

    listApiKeys: async () => [...apiKeys.values()].map(({ keyHash: _keyHash, ...summary }) => summary),

    createApiKey: async (name) => {
      const id = randomUUID();
      const secret = `blk_local_${randomUUID().replace(/-/g, "")}`;
      apiKeys.set(id, { id, name, createdAt: new Date().toISOString(), revoked: false, keyHash: hashApiKey(secret) });
      return { id, name, secret, createdAt: apiKeys.get(id)!.createdAt };
    },

    revokeApiKey: async (id) => {
      const existing = apiKeys.get(id);
      if (!existing || existing.revoked) return false;
      apiKeys.set(id, { ...existing, revoked: true });
      return true;
    },

    deleteApiKey: async (id) => {
      const existing = apiKeys.get(id);
      if (!existing || !existing.revoked) return false;
      return apiKeys.delete(id);
    },

    renderTemplatePng,
  };
}
