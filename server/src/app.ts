import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractBearerToken, hashApiKey } from "./auth.ts";
import { parseLayers, type Layers } from "./render/layers.ts";
import { pageCount, resolvePageIndex } from "./render/editableTweetTemplate.ts";
import { renderTemplatePng } from "./render/renderTweet.ts";
import { applyLayerOverrides } from "./render/applyLayerOverrides.ts";
import { publicRenderUrl, uploadRenderedPng, uploadUserPhoto } from "./storage.ts";
import type { ApiKeyOwner, ApiKeySummary, TemplateRow, TemplateSummary, Workspace } from "./db.ts";
import {
  clearSessionCookies,
  getAccessCookie,
  getRefreshCookie,
  refreshSession,
  resolveSessionFromCookies,
  setSessionCookies,
  signIn,
  signUp,
  verifyAccessToken,
} from "./supabaseAuth.ts";

/**
 * Presente só quando há um projeto Supabase de verdade configurado (fase 7 do plano de
 * migração). Sem isso: `GET /api/v1/templates/:id` não traz `downloadUrl`, `save:true` não
 * sobe o PNG pro bucket público, e `POST /api/v1/uploads` responde 501 — nenhuma dessas coisas
 * tem onde existir sem um projeto Supabase por trás.
 */
export interface StorageDeps {
  client: SupabaseClient;
}

/**
 * Presente só quando há um projeto Supabase de verdade configurado (fase 3 do plano de
 * migração). Em modo local puro (sem Postgres/Supabase — `server/src/local.ts`) isso é
 * omitido, e as rotas `/api/v1/auth/*` respondem 501: não faz sentido fingir Auth sem um
 * projeto Supabase por trás. As rotas de template/chave continuam funcionando via chave de
 * API Bearer normalmente, com ou sem isso configurado.
 */
export interface AuthDeps {
  client: SupabaseClient;
  /** Cria a "Chave padrão" logo após o signup — ver AppDeps.createApiKey (fase 2, já owner-aware). */
  createDefaultApiKey: (ownerId: string) => Promise<{ id: string; name: string; secret: string; createdAt: string }>;
}

export interface AppDeps {
  findApiKeyOwner: (keyHash: string) => Promise<ApiKeyOwner | null>;
  findTemplate: (ownerId: string, id: string) => Promise<TemplateRow | null>;
  listTemplates: (ownerId: string) => Promise<TemplateSummary[]>;
  createTemplate: (ownerId: string, input: { name: string; document: unknown }) => Promise<TemplateRow>;
  updateTemplate: (ownerId: string, id: string, input: { name?: string; document?: unknown }) => Promise<TemplateRow | null>;
  deleteTemplate: (ownerId: string, id: string) => Promise<boolean>;
  listApiKeys: (ownerId: string) => Promise<ApiKeySummary[]>;
  createApiKey: (ownerId: string, name: string) => Promise<{ id: string; name: string; secret: string; createdAt: string }>;
  revokeApiKey: (ownerId: string, id: string) => Promise<boolean>;
  deleteApiKey: (ownerId: string, id: string) => Promise<boolean>;
  findWorkspaceByEmail: (email: string) => Promise<Workspace | null>;
  createWorkspace: (input: { name: string; email: string }) => Promise<Workspace>;
  renderTemplatePng: typeof renderTemplatePng;
}

interface RenderBody {
  template?: string;
  layers?: Layers;
  /**
   * Qual página renderizar, base 1. Ausente = a página ativa que o documento
   * guardou, que é o comportamento de sempre para template de página única.
   *
   * Existe para o carrossel: o documento tem 3 slides e sem isto toda chamada
   * devolvia a capa. Base 1 porque é o número que o cliente da API usa ao falar
   * de "página 2"; o índice base 0 fica dentro do renderer.
   */
  page?: number;
  /**
   * Opt-in: grava as camadas resolvidas de volta na própria linha do template renderizado (só
   * na página que foi de fato renderizada) — o mesmo efeito de abrir o template no editor e
   * salvar, só que disparado pela API. Nada muda por padrão; sem isto o render continua sendo
   * só leitura, como sempre foi. Ver applyLayerOverrides.ts.
   */
  save?: boolean;
}

const BODY_LIMIT_BYTES = 10 * 1024 * 1024;

/** Chaves de API deste app sempre têm esse prefixo — é o que distingue "isto é uma chave de API,
 *  faça o hash e procure no banco" de "isto é um JWT do Supabase, verifique com o Auth". */
function looksLikeApiKey(token: string): boolean {
  return token.startsWith("blk_");
}

export function buildApp(deps: AppDeps, auth: AuthDeps | null = null, storage: StorageDeps | null = null): FastifyInstance {
  const app = Fastify({ bodyLimit: BODY_LIMIT_BYTES });
  app.register(fastifyCookie);
  app.register(fastifyMultipart, { limits: { fileSize: 15 * 1024 * 1024 } });

  /**
   * Resolve quem está chamando, em três caminhos possíveis (nessa ordem):
   *  1. Cookie de sessão do console (Supabase Auth) — só existe quando `auth` está configurado.
   *  2. Authorization: Bearer <chave de API> — o mecanismo de sempre, hash + lookup no banco.
   *  3. Authorization: Bearer <JWT do Supabase> — usado pela Edge Function da tela "Gerar", que
   *     repassa o JWT de quem está logado no navegador em vez de guardar uma chave de API própria.
   * Os três caminhos resolvem pro mesmo formato (ownerId) — nenhuma rota trata os três de forma
   * diferente depois disso.
   */
  async function requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    if (auth) {
      const bySession = await resolveSessionFromCookies(request, auth.client);
      if (bySession) return bySession.ownerId;
    }

    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      reply.code(401).send({ error: "missing session cookie or Authorization: Bearer <api key>" });
      return null;
    }

    if (looksLikeApiKey(token)) {
      const owner = await deps.findApiKeyOwner(hashApiKey(token));
      if (!owner) {
        reply.code(401).send({ error: "invalid or revoked API key" });
        return null;
      }
      return owner.ownerId;
    }

    if (auth) {
      const bySupabaseJwt = await verifyAccessToken(auth.client, token);
      if (bySupabaseJwt) return bySupabaseJwt.ownerId;
    }

    reply.code(401).send({ error: "invalid or revoked API key" });
    return null;
  }

  app.get("/health", async () => ({ ok: true }));

  app.post<{ Body: RenderBody }>("/api/v1/render", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;

    const { template, layers, page, save } = request.body ?? {};
    if (!template) return reply.code(400).send({ error: "missing required field: template" });

    const row = await deps.findTemplate(ownerId, template);
    if (!row) return reply.code(404).send({ error: `template not found: ${template}` });

    // Página fora do intervalo é erro, não silêncio: pedir a 4 num carrossel de 3
    // e receber a 3 faria o chamador achar que gerou o slide que pediu.
    let pageIndex: number | undefined;
    if (page !== undefined) {
      const total = pageCount(row.document);
      if (!Number.isInteger(page) || page < 1 || page > total) {
        return reply.code(400).send({
          error: `page must be an integer between 1 and ${total} for this template`,
        });
      }
      pageIndex = page - 1;
    }

    const parsedLayers = parseLayers(layers ?? {});

    let png: Buffer;
    try {
      png = await deps.renderTemplatePng(row.document, parsedLayers, pageIndex);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }

    // Opt-in: o mesmo efeito de abrir esse template no editor e salvar, só que disparado pela
    // API. A resposta continua sendo só o PNG de sempre — quem chamou já sabe o id do template
    // que passou, não tem id novo pra devolver.
    if (save) {
      const merged = applyLayerOverrides(row.document, parsedLayers, pageIndex);
      await deps.updateTemplate(ownerId, template, { document: merged });
      // O link público de download é um caminho determinístico (storage.ts) — só precisa do
      // arquivo existir de verdade, o que só acontece depois de um save:true.
      if (storage) {
        const resolvedIndex = resolvePageIndex(row.document, pageIndex) ?? 0;
        await uploadRenderedPng(storage.client, template, resolvedIndex, png).catch(() => {
          // Falha de upload não derruba o render — a pessoa já tem o PNG na resposta; o link
          // público só fica indisponível até o próximo save:true bem-sucedido.
        });
      }
    }

    return reply.header("content-type", "image/png").send(png);
  });

  app.get("/api/v1/templates", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    return deps.listTemplates(ownerId);
  });

  app.post<{ Body: { name?: string; document?: unknown } }>("/api/v1/templates", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const { name, document } = request.body ?? {};
    if (!name || !document) return reply.code(400).send({ error: "missing required field: name, document" });
    const row = await deps.createTemplate(ownerId, { name, document });
    return reply.code(201).send({ id: row.id, name: row.name });
  });

  app.get<{ Params: { id: string } }>("/api/v1/templates/:id", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const row = await deps.findTemplate(ownerId, request.params.id);
    if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
    // Caminho determinístico (storage.ts) — existe sempre que Storage está configurado, mesmo
    // que o arquivo em si só passe a existir depois do primeiro save:true.
    const downloadUrl = storage ? publicRenderUrl(storage.client, row.id) : undefined;
    return { id: row.id, name: row.name, document: row.document, downloadUrl };
  });

  app.get<{ Params: { id: string } }>("/api/v1/templates/:id/cover", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const row = await deps.findTemplate(ownerId, request.params.id);
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
      const ownerId = await requireOwner(request, reply);
      if (!ownerId) return;
      const row = await deps.updateTemplate(ownerId, request.params.id, request.body ?? {});
      if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      return { id: row.id, name: row.name };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/templates/:id", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const deleted = await deps.deleteTemplate(ownerId, request.params.id);
    if (!deleted) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
    return reply.code(204).send();
  });

  // Foto pro avatar/media de um template — vai pro bucket privado, isolada por dono via
  // prefixo de caminho (uploadUserPhoto, storage.ts). Devolve uma referência
  // (`supabase://uploads/...`) usável direto como `src` de uma layer de imagem; nunca uma URL
  // pública, porque a foto é privada por natureza (RLS do bucket exige o prefixo bater com
  // auth.uid(), e o render do Fastify busca isto com a chave service-role, ignorando RLS de
  // propósito — leitura servidor-a-servidor confiável, não uma requisição vinda do navegador).
  app.post("/api/v1/uploads", async (request, reply) => {
    if (!storage) return reply.code(501).send({ error: "Storage is not configured on this server" });
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;

    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "missing file" });
    const buffer = await file.toBuffer();
    const src = await uploadUserPhoto(storage.client, ownerId, file.filename, file.mimetype, buffer);
    return reply.code(201).send({ src });
  });

  app.get("/api/v1/keys", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    return deps.listApiKeys(ownerId);
  });

  app.post<{ Body: { name?: string } }>("/api/v1/keys", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const name = request.body?.name;
    if (!name) return reply.code(400).send({ error: "missing required field: name" });
    const created = await deps.createApiKey(ownerId, name);
    return reply.code(201).send(created);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/keys/:id", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const revoked = await deps.revokeApiKey(ownerId, request.params.id);
    if (!revoked) return reply.code(404).send({ error: `key not found or already revoked: ${request.params.id}` });
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>("/api/v1/keys/:id/purge", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const deleted = await deps.deleteApiKey(ownerId, request.params.id);
    if (!deleted) return reply.code(404).send({ error: `key not found, or not yet revoked: ${request.params.id}` });
    return reply.code(204).send();
  });

  // O console's login/signup: real rows na tabela workspaces, real 404/409, sem senha
  // verificada (ver o comentário na tabela workspaces em schema.sql). Substituído pela
  // sessão do Supabase Auth na fase 3 do plano de migração — mantido aqui até esse corte.
  app.get<{ Params: { email: string } }>("/api/v1/workspace/by-email/:email", async (request, reply) => {
    const workspace = await deps.findWorkspaceByEmail(decodeURIComponent(request.params.email));
    if (!workspace) return reply.code(404).send({ error: "no account with this e-mail" });
    return workspace;
  });

  app.post<{ Body: { name?: string; email?: string } }>("/api/v1/workspace", async (request, reply) => {
    const name = request.body?.name?.trim();
    const email = request.body?.email?.trim();
    if (!name || !email) return reply.code(400).send({ error: "missing required field: name, email" });
    // Check-then-create rather than relying on the table's unique constraint and
    // catching the error: this app has exactly one writer per environment (no
    // concurrent signups racing for the same e-mail in practice), so the small
    // TOCTOU window isn't worth reaching into postgres.js's error shape for.
    const existing = await deps.findWorkspaceByEmail(email);
    if (existing) return reply.code(409).send({ error: "an account with this e-mail already exists" });
    const workspace = await deps.createWorkspace({ name, email });
    return reply.code(201).send(workspace);
  });

  // --- Sessão via Supabase Auth (fase 3 do plano de migração) -----------------
  // Só existem de verdade quando `auth` foi passado pra buildApp — sem um projeto Supabase
  // configurado, 501: não tem Auth nenhum pra autenticar contra.
  function requireAuthConfigured(reply: FastifyReply): AuthDeps | null {
    if (auth) return auth;
    reply.code(501).send({ error: "Supabase Auth is not configured on this server" });
    return null;
  }

  app.post<{ Body: { name?: string; email?: string; password?: string } }>("/api/v1/auth/signup", async (request, reply) => {
    const a = requireAuthConfigured(reply);
    if (!a) return;
    const name = request.body?.name?.trim();
    const email = request.body?.email?.trim();
    const password = request.body?.password;
    if (!name || !email || !password) return reply.code(400).send({ error: "missing required field: name, email, password" });

    let result;
    try {
      result = await signUp(a.client, { name, email, password });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
    if (!result.session || !result.user) {
      // E-mail de confirmação exigido no projeto Supabase — não é o caso combinado (sem
      // confirmação), mas se alguém religar essa opção lá, é melhor um erro claro do que um
      // 200 com sessão vazia.
      return reply.code(400).send({ error: "signup succeeded but requires e-mail confirmation, which this app does not expect" });
    }

    setSessionCookies(reply, result.session);
    const defaultKey = await a.createDefaultApiKey(result.user.id);
    return reply.code(201).send({
      id: result.user.id,
      name,
      email: result.user.email,
      apiKey: { id: defaultKey.id, name: defaultKey.name, secret: defaultKey.secret },
    });
  });

  app.post<{ Body: { email?: string; password?: string } }>("/api/v1/auth/login", async (request, reply) => {
    const a = requireAuthConfigured(reply);
    if (!a) return;
    const email = request.body?.email?.trim();
    const password = request.body?.password;
    if (!email || !password) return reply.code(400).send({ error: "missing required field: email, password" });

    let result;
    try {
      result = await signIn(a.client, { email, password });
    } catch {
      return reply.code(401).send({ error: "invalid e-mail or password" });
    }
    if (!result.session || !result.user) return reply.code(401).send({ error: "invalid e-mail or password" });

    setSessionCookies(reply, result.session);
    return {
      id: result.user.id,
      name: typeof result.user.user_metadata?.name === "string" ? result.user.user_metadata.name : "",
      email: result.user.email,
    };
  });

  app.post("/api/v1/auth/logout", async (_request, reply) => {
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  app.post("/api/v1/auth/refresh", async (request, reply) => {
    const a = requireAuthConfigured(reply);
    if (!a) return;
    const refreshToken = getRefreshCookie(request);
    if (!refreshToken) return reply.code(401).send({ error: "no session to refresh" });

    let result;
    try {
      result = await refreshSession(a.client, refreshToken);
    } catch {
      clearSessionCookies(reply);
      return reply.code(401).send({ error: "session expired, please log in again" });
    }
    if (!result.session) {
      clearSessionCookies(reply);
      return reply.code(401).send({ error: "session expired, please log in again" });
    }
    setSessionCookies(reply, result.session);
    return reply.code(204).send();
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    const a = requireAuthConfigured(reply);
    if (!a) return;
    const user = await resolveSessionFromCookies(request, a.client);
    if (!user) return reply.code(401).send({ error: "not signed in" });
    return user;
  });

  // Só existe pra tela "Gerar": o navegador não consegue ler o cookie httpOnly sozinho, mas
  // precisa de um jeito de anexar "quem está logado" na chamada à Edge Function (que é uma
  // origem diferente — cookie nenhum atravessa isso). Devolve o mesmo JWT que já está no
  // cookie, só que como o corpo de uma resposta same-origin, pra virar Authorization: Bearer
  // na chamada seguinte. Só funciona por já haver uma sessão de cookie válida — não é um jeito
  // novo de logar, é a mesma sessão vista de outro ângulo.
  app.get("/api/v1/auth/token", async (request, reply) => {
    const a = requireAuthConfigured(reply);
    if (!a) return;
    const user = await resolveSessionFromCookies(request, a.client);
    if (!user) return reply.code(401).send({ error: "not signed in" });
    return { accessToken: getAccessCookie(request) };
  });

  return app;
}
