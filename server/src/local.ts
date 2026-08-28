import { randomUUID } from "node:crypto";
import { hashApiKey } from "./auth.ts";
import type { AppDeps } from "./app.ts";
import type { ApiKeySummary, TemplateRow, Workspace } from "./db.ts";

const SEED_TEMPLATE: TemplateRow = {
  id: "tweet-screenshot",
  kind: "tweet",
  name: "Tweet Hollywood creators",
  document: {
    name: "Tweet Hollywood creators",
    active: 0,
    pages: [{
      id: "tweet-page",
      w: 1080,
      h: 1350,
      bg: "#000000",
      els: [
        { id: "avatar-field", type: "image", name: "avatar", x: 72, y: 64, w: 96, h: 96, radius: 48, src: "https://placehold.co/96x96/2f3336/71757a?text=+" },
        { id: "displayName-field", type: "text", name: "displayName", x: 188, y: 66, w: 820, h: 40, text: "Micael Crasto", font: "Inter", size: 34, weight: 700, align: "left", lh: 1.25, fill: "#E6E9EA" },
        { id: "handle-field", type: "text", name: "handle", x: 188, y: 110, w: 820, h: 34, text: "@MicaelCrasto", font: "Inter", size: 28, weight: 400, align: "left", lh: 1.25, fill: "#71757A" },
        { id: "tweetText-field", type: "text", name: "tweetText", x: 72, y: 192, w: 936, h: 290, text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n\nUt enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.", font: "Inter", size: 34, weight: 400, align: "left", lh: 1.4, fill: "#E6E9EA" },
        { id: "media-field", type: "image", name: "media", x: 72, y: 506, w: 936, h: 620, radius: 24, src: "https://placehold.co/936x620/2f3336/71757a?text=+" },
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
  ]);
  const apiKeys = new Map<string, StoredApiKey>();
  const workspaces = new Map<string, Workspace>(); // key: lowercased e-mail

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
      if (keyHash === configuredHash) return { id: "local", name: "local development" };
      const owner = [...apiKeys.values()].find((k) => k.keyHash === keyHash && !k.revoked);
      return owner ? { id: owner.id, name: owner.name } : null;
    },

    findTemplate: async (id) => templates.get(id) ?? null,

    // Mais recente primeiro, igual ao `order by updated_at desc` do Postgres em
    // db.ts — a home mostra os últimos editados e as duas pontas têm que
    // concordar na ordem.
    listTemplates: async () =>
      [...templates.values()]
        .map((t) => ({ id: t.id, name: t.name, updatedAt: touchedAt.get(t.id) ?? new Date(bootedAt).toISOString() }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),

    createTemplate: async ({ name, document }) => {
      const row: TemplateRow = { id: randomUUID(), kind: "custom", name, document };
      templates.set(row.id, row);
      touch(row.id);
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
      touch(id);
      return updated;
    },

    deleteTemplate: async (id) => {
      touchedAt.delete(id);
      return templates.delete(id);
    },

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

    findWorkspaceByEmail: async (email) => workspaces.get(email.toLowerCase()) ?? null,

    createWorkspace: async ({ name, email }) => {
      const workspace: Workspace = { id: randomUUID(), name, email: email.toLowerCase() };
      workspaces.set(workspace.email, workspace);
      return workspace;
    },

    renderTemplatePng,
  };
}
