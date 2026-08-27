import Fastify, { type FastifyInstance } from "fastify";
import { extractBearerToken, hashApiKey } from "./auth.ts";
import { mapLayersToTweetInput, LayerValidationError, type Layers } from "./render/layers.ts";
import type { RenderTweetInput } from "./render/renderTweet.ts";
import type { ApiKeyOwner, TemplateRow } from "./db.ts";

export interface AppDeps {
  findApiKeyOwner: (keyHash: string) => Promise<ApiKeyOwner | null>;
  findTemplate: (id: string, kind: string) => Promise<TemplateRow | null>;
  renderTweetPng: (input: RenderTweetInput) => Promise<Buffer>;
}

interface RenderBody {
  template?: string;
  layers?: Layers;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify();

  app.post<{ Body: RenderBody }>("/api/v1/render", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ error: "missing Authorization: Bearer <api key>" });

    const owner = await deps.findApiKeyOwner(hashApiKey(token));
    if (!owner) return reply.code(401).send({ error: "invalid or revoked API key" });

    const { template, layers } = request.body ?? {};
    if (!template) return reply.code(400).send({ error: "missing required field: template" });

    const row = await deps.findTemplate(template, "tweet");
    if (!row) return reply.code(404).send({ error: `template not found: ${template}` });

    let input: RenderTweetInput;
    try {
      input = mapLayersToTweetInput(layers ?? {});
    } catch (err) {
      if (err instanceof LayerValidationError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    let png: Buffer;
    try {
      png = await deps.renderTweetPng(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Anything renderTweetPng throws today (SSRF guard, unreachable/oversized image) is a bad-input
      // problem, not a server fault — surface it as 400 rather than a generic 500.
      return reply.code(400).send({ error: message });
    }

    return reply.header("content-type", "image/png").send(png);
  });

  return app;
}
