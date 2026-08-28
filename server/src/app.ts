import Fastify, { type FastifyInstance } from "fastify";
import { extractBearerToken, hashApiKey } from "./auth.ts";
import { parseLayers, type Layers } from "./render/layers.ts";
import { renderTemplatePng } from "./render/renderTweet.ts";
import type { ApiKeyOwner, ApiKeySummary, TemplateRow, TemplateSummary } from "./db.ts";

export interface AppDeps {
  findApiKeyOwner: (keyHash: string) => Promise<ApiKeyOwner | null>;
  findTemplate: (id: string) => Promise<TemplateRow | null>;
  listTemplates: () => Promise<TemplateSummary[]>;
  createTemplate: (input: { name: string; document: unknown }) => Promise<TemplateRow>;
  updateTemplate: (id: string, input: { name?: string; document?: unknown }) => Promise<TemplateRow | null>;
  deleteTemplate: (id: string) => Promise<boolean>;
  listApiKeys: () => Promise<ApiKeySummary[]>;
  createApiKey: (name: string) => Promise<{ id: string; name: string; secret: string; createdAt: string }>;
  revokeApiKey: (id: string) => Promise<boolean>;
  deleteApiKey: (id: string) => Promise<boolean>;
  renderTemplatePng: typeof renderTemplatePng;
}

interface RenderBody {
  template?: string;
  layers?: Layers;
}

const BODY_LIMIT_BYTES = 10 * 1024 * 1024;

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ bodyLimit: BODY_LIMIT_BYTES });

  app.get("/health", async () => ({ ok: true }));

  app.post<{ Body: RenderBody }>("/api/v1/render", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ error: "missing Authorization: Bearer <api key>" });

    const owner = await deps.findApiKeyOwner(hashApiKey(token));
    if (!owner) return reply.code(401).send({ error: "invalid or revoked API key" });

    const { template, layers } = request.body ?? {};
    if (!template) return reply.code(400).send({ error: "missing required field: template" });

    const row = await deps.findTemplate(template);
    if (!row) return reply.code(404).send({ error: `template not found: ${template}` });

    let png: Buffer;
    try {
      png = await deps.renderTemplatePng(row.document, parseLayers(layers ?? {}));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }

    return reply.header("content-type", "image/png").send(png);
  });

  app.get("/api/v1/templates", async () => deps.listTemplates());

  app.post<{ Body: { name?: string; document?: unknown } }>("/api/v1/templates", async (request, reply) => {
    const { name, document } = request.body ?? {};
    if (!name || !document) return reply.code(400).send({ error: "missing required field: name, document" });
    const row = await deps.createTemplate({ name, document });
    return reply.code(201).send({ id: row.id, name: row.name });
  });

  app.get<{ Params: { id: string } }>("/api/v1/templates/:id", async (request, reply) => {
    const row = await deps.findTemplate(request.params.id);
    if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
    return { id: row.id, name: row.name, document: row.document };
  });

  app.get<{ Params: { id: string } }>("/api/v1/templates/:id/cover", async (request, reply) => {
    const row = await deps.findTemplate(request.params.id);
    if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
    try {
      const png = await deps.renderTemplatePng(row.document, parseLayers({}));
      return reply
        .header("content-type", "image/png")
        .header("cache-control", "private, max-age=20")
        .send(png);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.put<{ Params: { id: string }; Body: { name?: string; document?: unknown } }>(
    "/api/v1/templates/:id",
    async (request, reply) => {
      const row = await deps.updateTemplate(request.params.id, request.body ?? {});
      if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      return { id: row.id, name: row.name };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/templates/:id", async (request, reply) => {
    const deleted = await deps.deleteTemplate(request.params.id);
    if (!deleted) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
    return reply.code(204).send();
  });

  app.get("/api/v1/keys", async () => deps.listApiKeys());

  app.post<{ Body: { name?: string } }>("/api/v1/keys", async (request, reply) => {
    const name = request.body?.name;
    if (!name) return reply.code(400).send({ error: "missing required field: name" });
    const created = await deps.createApiKey(name);
    return reply.code(201).send(created);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/keys/:id", async (request, reply) => {
    const revoked = await deps.revokeApiKey(request.params.id);
    if (!revoked) return reply.code(404).send({ error: `key not found or already revoked: ${request.params.id}` });
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>("/api/v1/keys/:id/purge", async (request, reply) => {
    const deleted = await deps.deleteApiKey(request.params.id);
    if (!deleted) return reply.code(404).send({ error: `key not found, or not yet revoked: ${request.params.id}` });
    return reply.code(204).send();
  });

  return app;
}
