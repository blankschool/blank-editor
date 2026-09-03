import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractBearerToken, hashApiKey } from "./auth.ts";
import { familyMatchesFile } from "./fonts/sfntNames.ts";
import { parseLayers, type Layers } from "./render/layers.ts";
import { DEFAULT_FONT_FAMILY, pageCount, resolvePageIndex } from "./render/editableTweetTemplate.ts";
import { canarioDeFonte } from "./render/preflight.ts";
import { renderTemplatePng } from "./render/renderTweet.ts";
import { applyLayerOverrides } from "./render/applyLayerOverrides.ts";
import { PRIVATE_UPLOAD_PREFIX, publicRenderUrl, signPrivateUploadUrl, uploadFontFace, uploadRenderedPng, uploadUserPhoto } from "./storage.ts";
import type { ApiKeyOwner, ApiKeySummary, FontFaceInput, FontFaceRow, TemplateRow, TemplateSummary } from "./db.ts";
import { buildGeneratedDocument, GenerationDocumentError, type GenerationPageInput } from "./generationDocument.ts";
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
  createTemplate: (ownerId: string, input: { id?: string; name: string; document: unknown }) => Promise<TemplateRow>;
  updateTemplate: (ownerId: string, id: string, input: { name?: string; document?: unknown }) => Promise<TemplateRow | null>;
  deleteTemplate: (ownerId: string, id: string) => Promise<boolean>;
  listApiKeys: (ownerId: string) => Promise<ApiKeySummary[]>;
  createApiKey: (ownerId: string, name: string) => Promise<{ id: string; name: string; secret: string; createdAt: string }>;
  revokeApiKey: (ownerId: string, id: string) => Promise<boolean>;
  deleteApiKey: (ownerId: string, id: string) => Promise<boolean>;
  renderTemplatePng: typeof renderTemplatePng;
  upsertFontFace: (input: FontFaceInput) => Promise<FontFaceRow>;
  listFontFaces: (ownerId: string) => Promise<FontFaceRow[]>;
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

interface GenerationBody {
  template?: string;
  name?: string;
  pages?: GenerationPageInput[];
}

const BODY_LIMIT_BYTES = 10 * 1024 * 1024;

function generatedDesignId(ownerId: string, idempotencyKey: string): string {
  return `generation-${createHash("sha256").update(`${ownerId}\0${idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

  /** Faces registradas do dono, para o render resolver família que o documento não declara. */
  async function facesDoRegistry(ownerId: string) {
    return (await deps.listFontFaces(ownerId)).map((f) => ({
      family: f.internalFamily, weight: f.weight, sha256: f.sha256, src: f.sfntPath,
    }));
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
      png = await deps.renderTemplatePng(row.document, parsedLayers, pageIndex, await facesDoRegistry(ownerId));
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

  app.post<{ Body: GenerationBody }>("/api/v1/generations", async (request, reply) => {
    if (!storage) return reply.code(501).send({ error: "Storage is not configured on this server" });
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      return reply.code(400).send({ error: "missing required header: Idempotency-Key" });
    }
    if (idempotencyKey.length > 200) return reply.code(400).send({ error: "Idempotency-Key must be at most 200 characters" });

    const { template, name, pages } = request.body ?? {};
    if (!template || !name?.trim() || !Array.isArray(pages)) {
      return reply.code(400).send({ error: "missing required field: template, name, pages" });
    }
    if (pages.length < 1 || pages.length > 20) {
      return reply.code(400).send({ error: "pages must contain between 1 and 20 items" });
    }
    for (const [index, page] of pages.entries()) {
      if (!isRecord(page) || !isRecord(page.layers)) {
        return reply.code(400).send({ error: `pages[${index}].layers must be an object` });
      }
      for (const [layerName, value] of Object.entries(page.layers)) {
        if (!layerName || !isRecord(value)) {
          return reply.code(400).send({ error: `pages[${index}].layers.${layerName || "<empty>"} must be an object` });
        }
      }
    }

    const designId = generatedDesignId(ownerId, idempotencyKey.trim());
    let row = await deps.findTemplate(ownerId, designId);
    let replay = Boolean(row);
    let preRendered: Buffer[] | null = null;

    if (!row) {
      const source = await deps.findTemplate(ownerId, template);
      if (!source) return reply.code(404).send({ error: `template not found: ${template}` });

      let document;
      try {
        document = buildGeneratedDocument(source.document, name.trim(), pages);
      } catch (err) {
        if (err instanceof GenerationDocumentError) return reply.code(400).send({ error: err.message });
        throw err;
      }
      document.seedId = designId;

      const faces = await facesDoRegistry(ownerId);
      try {
        preRendered = await Promise.all(document.pages.map((_page, index) =>
          deps.renderTemplatePng(document, parseLayers({}), index, faces)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: `render failed: ${message}` });
      }
      try {
        row = await deps.createTemplate(ownerId, { id: designId, name: name.trim(), document });
      } catch (createError) {
        // Duas execuções podem chegar entre o find e o insert com a mesma chave.
        // A constraint de templates escolhe a primeira; a segunda passa a ser um
        // replay e renderiza o documento vencedor, sem reaplicar seu próprio body.
        const concurrentWinner = await deps.findTemplate(ownerId, designId);
        if (!concurrentWinner) throw createError;
        row = concurrentWinner;
        replay = true;
        preRendered = null;
      }
    }

    const document = row.document as { pages?: unknown[] };
    const total = Array.isArray(document.pages) ? document.pages.length : 0;
    const faces = await facesDoRegistry(ownerId);
    let pngs: Buffer[];
    try {
      pngs = preRendered ?? await Promise.all(Array.from({ length: total }, (_unused, index) =>
        deps.renderTemplatePng(row!.document, parseLayers({}), index, faces)));
      await Promise.all(pngs.map((png, index) => uploadRenderedPng(storage.client, row!.id, index, png)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `could not publish generated renders: ${message}` });
    }

    return reply.code(replay ? 200 : 201).send({
      design: {
        id: row.id,
        name: row.name,
        pageCount: total,
        editorPath: `/#/editor/${encodeURIComponent(row.id)}`,
        pages: Array.from({ length: total }, (_unused, index) => ({
          page: index + 1,
          pngUrl: publicRenderUrl(storage.client, row!.id, index),
        })),
      },
    });
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
      const png = await deps.renderTemplatePng(row.document, parseLayers({}), undefined, await facesDoRegistry(ownerId));
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

  // Registra uma face de fonte que pertence a um design, não ao app (Doc.fonts em src/types.ts).
  //
  // Recebe os dois formatos numa chamada só — SFNT para o rasterizador, WOFF2 para o navegador —
  // porque são a mesma face lógica: aceitar um sem o outro deixaria um design que abre no canvas
  // e não renderiza, ou o contrário.
  //
  // Fronteira de confiança: o `sha256` é calculado AQUI a partir dos bytes, nunca aceito do
  // cliente — é a identidade da face e a chave do cache do renderer. Os metadados descritivos
  // (família, peso, estilo) vêm do cliente, que os leu do próprio arquivo com fontTools; validá-los
  // no servidor exigiria um parser de fonte em Node, e a consequência de um erro ali é cosmética,
  // não de integridade.
  app.post("/api/v1/fonts", async (request, reply) => {
    if (!storage) return reply.code(501).send({ error: "Storage is not configured on this server" });
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;

    const arquivos: Record<string, { filename: string; bytes: Buffer }> = {};
    const campos: Record<string, string> = {};
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "sfnt" && part.fieldname !== "woff2") {
          await part.toBuffer();
          continue;
        }
        arquivos[part.fieldname] = { filename: part.filename, bytes: await part.toBuffer() };
      } else if (typeof part.value === "string") {
        campos[part.fieldname] = part.value;
      }
    }

    if (!arquivos.sfnt || !arquivos.woff2) {
      return reply.code(400).send({ error: "envie os dois arquivos da face: campos 'sfnt' e 'woff2'" });
    }
    if (!/\.(ttf|otf)$/i.test(arquivos.sfnt.filename) || !/\.woff2$/i.test(arquivos.woff2.filename)) {
      return reply.code(400).send({ error: "'sfnt' deve ser .ttf/.otf e 'woff2' deve ser .woff2" });
    }
    const internalFamily = (campos.internalFamily || "").trim();
    const weight = Number(campos.weight);
    if (!internalFamily || !Number.isFinite(weight)) {
      return reply.code(400).send({ error: "campos obrigatórios: internalFamily, weight" });
    }

    // A família declarada tem que existir DENTRO do arquivo. Sem esta conferência, registrar
    // "Inter" apontando para outro arquivo passa: o rasterizador não reclama de família que não
    // casa, ele desenha com a primeira fonte carregada. O erro só apareceria como arte errada.
    const familia = familyMatchesFile(internalFamily, arquivos.sfnt.bytes);
    if (!familia.ok) {
      return reply.code(400).send({
        error: `família declarada "${internalFamily}" não existe no arquivo enviado ` +
          `(ele responde por ${familia.noArquivo.map((n) => `"${n}"`).join(", ")}). ` +
          `O rasterizador não acusaria isso — ele desenharia com outra fonte.`,
      });
    }

    const sha256 = createHash("sha256").update(arquivos.sfnt.bytes).digest("hex");
    const ext = arquivos.sfnt.filename.toLowerCase().endsWith(".otf") ? "otf" : "ttf";
    const { sfntPath, woff2Path } = await uploadFontFace(
      storage.client, sha256, { ext, bytes: arquivos.sfnt.bytes }, arquivos.woff2.bytes);
    const face = await deps.upsertFontFace({
      id: randomUUID(), ownerId, sha256, internalFamily,
      postscriptName: campos.postscriptName || null,
      weight, style: campos.style || "Regular",
      stretch: campos.stretch || null,
      os2FsType: campos.os2FsType ? Number(campos.os2FsType) : null,
      sfntPath, woff2Path,
    });
    return reply.code(201).send(face);
  });

  // Diagnóstico sob demanda: "este servidor consegue desenhar texto para mim?"
  //
  // Não é preflight de boot porque as faces são por dono — no boot não há dono para checar. E é
  // rasterização de verdade, não contagem de linhas: a falha interessante é a linha existir, o
  // arquivo existir, e o texto sair vazio mesmo assim.
  app.get<{ Querystring: { family?: string } }>("/health/fonts", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const family = request.query.family || DEFAULT_FONT_FAMILY;
    const faces = (await deps.listFontFaces(ownerId))
      .filter((f) => f.internalFamily.toLowerCase() === family.toLowerCase())
      .map((f) => ({ family: f.internalFamily, weight: f.weight, sha256: f.sha256, src: f.sfntPath }));
    const resultado = await canarioDeFonte(faces, family);
    return reply.code(resultado.ok ? 200 : 503).send(resultado);
  });

  // As faces que este dono já registrou — o console usa para mostrar o que um design carrega e
  // avisar sobre embedding restrito (os2FsType).
  app.get("/api/v1/fonts", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    return deps.listFontFaces(ownerId);
  });

  // O editor roda no navegador, sem a chave service-role — não consegue buscar um `src` privado
  // (`supabase://uploads/...`) direto, só o servidor sabe resolver isso. Esta rota devolve uma
  // URL assinada de curta duração que o `<img>`/canvas do editor já consegue carregar sozinho.
  // A checagem de prefixo por ownerId é o que impede alguém logado assinar a URL de outro dono —
  // o cliente Storage é service-role e ignora RLS de propósito, então a garantia é aqui.
  app.get<{ Querystring: { ref?: string } }>("/api/v1/uploads/resolve", async (request, reply) => {
    if (!storage) return reply.code(501).send({ error: "Storage is not configured on this server" });
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;

    const ref = request.query.ref;
    if (!ref || !ref.startsWith(PRIVATE_UPLOAD_PREFIX)) return reply.code(400).send({ error: "missing or invalid ref" });
    if (!ref.slice(PRIVATE_UPLOAD_PREFIX.length).startsWith(`${ownerId}/`)) {
      return reply.code(403).send({ error: "ref does not belong to this owner" });
    }
    const url = await signPrivateUploadUrl(storage.client, ref);
    return { url };
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
