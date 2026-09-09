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
import {
  PRIVATE_UPLOAD_PREFIX,
  publicApprovedRenderUrl,
  publicRenderUrl,
  signDraftRenderUrl,
  signPrivateUploadUrl,
  uploadApprovedRender,
  uploadDraftRender,
  uploadFontFace,
  uploadRenderedPng,
  uploadUserPhoto,
} from "./storage.ts";
import type { ApiKeyOwner, ApiKeySummary, BrandKitRow, DesignCommentReply, DesignCommentRow, DesignVersionRow, FontFaceInput, FontFaceRow, ShareVisibility, TemplateRow, TemplateSummary } from "./db.ts";
import { buildGeneratedDocument, GenerationDocumentError, type GenerationPageInput } from "./generationDocument.ts";
import { createMemoryGenerationRepository, hashJson, type GenerationRepository, type GenerationRun } from "./generationWorkflow.ts";
import type { AcquiredMedia, MediaAcquisitionService, MediaAssetRequest } from "./mediaAcquisition.ts";
import { FlattenedPdfError, type ImportedPage, type ImportedFont, type ImportedImage, type PdfImportService } from "./pdfImportService.ts";
import type { FontMatch, FontMatchHint } from "./render/googleFontMatch.ts";
import type { FetchedGoogleFont } from "./render/googleFontFetch.ts";
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
  updateTemplate: (ownerId: string, id: string, input: { name?: string; document?: unknown; favorite?: boolean }) => Promise<TemplateRow | null>;
  deleteTemplate: (ownerId: string, id: string) => Promise<boolean>;
  listApiKeys: (ownerId: string) => Promise<ApiKeySummary[]>;
  createApiKey: (ownerId: string, name: string) => Promise<{ id: string; name: string; secret: string; createdAt: string }>;
  revokeApiKey: (ownerId: string, id: string) => Promise<boolean>;
  deleteApiKey: (ownerId: string, id: string) => Promise<boolean>;
  renderTemplatePng: typeof renderTemplatePng;
  upsertFontFace: (input: FontFaceInput) => Promise<FontFaceRow>;
  listFontFaces: (ownerId: string) => Promise<FontFaceRow[]>;
  generations?: GenerationRepository;
  listDesignVersions: (ownerId: string, templateId: string) => Promise<DesignVersionRow[]>;
  createDesignVersion: (ownerId: string, input: { templateId: string; name: string; document: unknown }) => Promise<DesignVersionRow>;
  findDesignVersion: (ownerId: string, templateId: string, id: string) => Promise<DesignVersionRow | null>;
  deleteDesignVersion: (ownerId: string, templateId: string, id: string) => Promise<boolean>;
  getDesignShareVisibility: (ownerId: string, templateId: string) => Promise<ShareVisibility>;
  setDesignShareVisibility: (ownerId: string, templateId: string, visibility: ShareVisibility) => Promise<void>;
  getPublicShareVisibility: (templateId: string) => Promise<ShareVisibility>;
  findTemplatePublic: (id: string) => Promise<TemplateRow | null>;
  listDesignComments: (ownerId: string, templateId: string) => Promise<DesignCommentRow[]>;
  createDesignComment: (
    ownerId: string,
    input: { templateId: string; pageIndex: number; x: number; y: number; body: string },
  ) => Promise<DesignCommentRow>;
  setDesignCommentResolved: (ownerId: string, templateId: string, id: string, resolved: boolean) => Promise<boolean>;
  deleteDesignComment: (ownerId: string, templateId: string, id: string) => Promise<boolean>;
  createDesignCommentReply: (
    ownerId: string,
    templateId: string,
    commentId: string,
    body: string,
  ) => Promise<DesignCommentReply | null>;
  listBrandKits: (ownerId: string) => Promise<BrandKitRow[]>;
  createBrandKit: (ownerId: string, input: { name: string; colors: string[]; fonts: string[] }) => Promise<BrandKitRow>;
  deleteBrandKit: (ownerId: string, id: string) => Promise<boolean>;
}

export interface MediaDeps {
  service: MediaAcquisitionService;
}

export interface PdfImportDeps {
  service: PdfImportService;
}

/** Opcional: sem isto, um bloco de texto que o Fix 2 já trocou por Inter (fonte do PDF não
 *  reconstruída) continua saindo em Inter — este dep só tenta melhorar isso pra uma Google Font
 *  parecida, nunca é pré-requisito pro import funcionar. */
export interface GoogleFontsDeps {
  match: (pageImagePng: Buffer, hints: readonly FontMatchHint[]) => Promise<Map<string, FontMatch>>;
  fetchFace: (family: string, weight: number) => Promise<FetchedGoogleFont | null>;
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
  run_id?: string;
}

// 50MB: um carrossel de PDF exportado do Canva com várias fotos em alta resolução passa fácil
// dos 10-15MB que bastavam para upload de uma foto/fonte avulsa.
const BODY_LIMIT_BYTES = 50 * 1024 * 1024;

function generatedDesignId(ownerId: string, idempotencyKey: string): string {
  return `generation-${createHash("sha256").update(`${ownerId}\0${idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

function generationId(ownerId: string, idempotencyKey: string): string {
  return `gen-${createHash("sha256").update(`${ownerId}\0${idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Chaves de API deste app sempre têm esse prefixo — é o que distingue "isto é uma chave de API,
 *  faça o hash e procure no banco" de "isto é um JWT do Supabase, verifique com o Auth". */
function looksLikeApiKey(token: string): boolean {
  return token.startsWith("blk_");
}

export function buildApp(
  deps: AppDeps,
  auth: AuthDeps | null = null,
  storage: StorageDeps | null = null,
  media: MediaDeps | null = null,
  pdfImport: PdfImportDeps | null = null,
  googleFonts: GoogleFontsDeps | null = null,
): FastifyInstance {
  const app = Fastify({ bodyLimit: BODY_LIMIT_BYTES });
  // O logger do Fastify está desligado (`Fastify({...})` sem `logger`) — sem isto, qualquer
  // exceção não tratada numa rota vira um 500 sem NENHUM rastro, nem no terminal do servidor.
  // Não muda a resposta que o cliente recebe (Fastify já respondia 500 sozinho); só garante que
  // o erro real fica visível pra diagnosticar.
  app.setErrorHandler((err, request, reply) => {
    console.error(`[${request.method} ${request.url}] erro não tratado:`, err);
    reply.send(err);
  });
  const generations = deps.generations ?? createMemoryGenerationRepository();
  app.register(fastifyCookie);
  app.register(fastifyMultipart, { limits: { fileSize: BODY_LIMIT_BYTES } });

  /**
   * Resolve quem está chamando, em três caminhos possíveis (nessa ordem):
   *  1. Cookie de sessão do console (Supabase Auth) — só existe quando `auth` está configurado.
   *  2. Authorization: Bearer <chave de API> — o mecanismo de sempre, hash + lookup no banco.
   *  3. Authorization: Bearer <JWT do Supabase> — usado pela Edge Function da tela "Gerar", que
   *     repassa o JWT de quem está logado no navegador em vez de guardar uma chave de API própria.
   * Os três caminhos resolvem pro mesmo formato (ownerId) — nenhuma rota trata os três de forma
   * diferente depois disso.
   */
  interface Principal { ownerId: string; actorId: string | null; kind: "human" | "api_key" }

  async function requirePrincipal(request: FastifyRequest, reply: FastifyReply): Promise<Principal | null> {
    if (auth) {
      const bySession = await resolveSessionFromCookies(request, auth.client);
      if (bySession) return { ownerId: bySession.ownerId, actorId: bySession.ownerId, kind: "human" };
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
      return { ownerId: owner.ownerId, actorId: null, kind: "api_key" };
    }

    if (auth) {
      const bySupabaseJwt = await verifyAccessToken(auth.client, token);
      if (bySupabaseJwt) return { ownerId: bySupabaseJwt.ownerId, actorId: bySupabaseJwt.ownerId, kind: "human" };
    }

    reply.code(401).send({ error: "invalid or revoked API key" });
    return null;
  }

  async function requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    return (await requirePrincipal(request, reply))?.ownerId ?? null;
  }

  async function requireHuman(request: FastifyRequest, reply: FastifyReply): Promise<Principal | null> {
    const principal = await requirePrincipal(request, reply);
    if (!principal) return null;
    if (principal.kind !== "human" || !principal.actorId) {
      reply.code(403).send({ error: "approval actions require an authenticated editor" });
      return null;
    }
    return principal;
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
      const changed = hashJson(merged) !== hashJson(row.document);
      const linkedGeneration = changed
        ? await generations.markEdited(ownerId, template)
        : await generations.findByDesign(ownerId, template);
      // O link público de download é um caminho determinístico (storage.ts) — só precisa do
      // arquivo existir de verdade, o que só acontece depois de um save:true. Gerações em
      // revisão são a exceção: seus previews ficam no bucket privado até a aprovação.
      if (storage) {
        const resolvedIndex = resolvePageIndex(row.document, pageIndex) ?? 0;
        const upload = linkedGeneration
          ? uploadDraftRender(
            storage.client,
            ownerId,
            linkedGeneration.id,
            linkedGeneration.currentVersion,
            resolvedIndex,
            png,
          )
          : uploadRenderedPng(storage.client, template, resolvedIndex, png);
        await upload.catch(() => {
          // Falha de upload não derruba o render — a pessoa já tem o PNG na resposta; o link
          // público só fica indisponível até o próximo save:true bem-sucedido.
        });
      }
    }

    return reply.header("content-type", "image/png").send(png);
  });

  interface ResolvedMedia {
    page: number;
    layerName: string;
    request: MediaAssetRequest;
    acquired: AcquiredMedia;
    storageRef: string;
  }

  function parseMediaRequest(value: unknown, path: string): MediaAssetRequest {
    if (!isRecord(value) || (value.strategy !== "stock" && value.strategy !== "ai")) {
      throw new GenerationDocumentError(`${path}.asset.strategy must be stock or ai`);
    }
    for (const field of ["query", "prompt", "aspectRatio"] as const) {
      if (value[field] !== undefined && typeof value[field] !== "string") {
        throw new GenerationDocumentError(`${path}.asset.${field} must be a string`);
      }
    }
    return {
      strategy: value.strategy,
      ...(typeof value.query === "string" ? { query: value.query } : {}),
      ...(typeof value.prompt === "string" ? { prompt: value.prompt } : {}),
      ...(typeof value.aspectRatio === "string" ? { aspectRatio: value.aspectRatio } : {}),
    };
  }

  async function resolveGenerationMedia(
    ownerId: string,
    genId: string,
    pages: readonly GenerationPageInput[],
  ): Promise<{ pages: GenerationPageInput[]; assets: ResolvedMedia[] }> {
    const resolved = structuredClone(Array.from(pages));
    const requested = resolved.flatMap((page, pageIndex) => Object.entries(page.layers)
      .filter(([, value]) => value.asset !== undefined)
      .map(([layerName, value]) => ({
        pageIndex,
        layerName,
        request: parseMediaRequest(value.asset, `pages[${pageIndex}].layers.${layerName}`),
      })));
    if (requested.length > 20) throw new GenerationDocumentError("a generation can acquire at most 20 images");
    if (requested.length > 0 && !media) throw new GenerationDocumentError("media acquisition is not configured on this server");

    const assets: ResolvedMedia[] = [];
    // Deliberately serial: provider quotas are usually lower than render concurrency, and a
    // five-card carousel should not burst five expensive image requests at once.
    for (const item of requested) {
      const mediaRequest = item.request;
      const acquired = await media!.service.acquire(mediaRequest);
      const filename = `${genId}-page-${item.pageIndex + 1}-${item.layerName}.${acquired.extension}`;
      const storageRef = await uploadUserPhoto(storage!.client, ownerId, filename, acquired.contentType, acquired.bytes);
      const { asset: _asset, ...layerValue } = resolved[item.pageIndex].layers[item.layerName];
      resolved[item.pageIndex].layers[item.layerName] = { ...layerValue, image_url: storageRef };
      assets.push({ page: item.pageIndex + 1, layerName: item.layerName, request: mediaRequest, acquired, storageRef });
    }
    return { pages: resolved, assets };
  }

  async function renderAllPages(ownerId: string, document: unknown): Promise<Buffer[]> {
    const total = Array.isArray((document as { pages?: unknown[] })?.pages)
      ? (document as { pages: unknown[] }).pages.length
      : 0;
    const faces = await facesDoRegistry(ownerId);
    return Promise.all(Array.from({ length: total }, (_unused, index) =>
      deps.renderTemplatePng(document, parseLayers({}), index, faces)));
  }

  async function generationPayload(run: GenerationRun, row: TemplateRow) {
    const document = row.document as { pages?: unknown[] };
    const total = Array.isArray(document.pages) ? document.pages.length : 0;
    const approvedCurrent = run.reviewStatus === "approved" && run.approvedVersion === run.currentVersion;
    const pages = await Promise.all(Array.from({ length: total }, async (_unused, index) => ({
      page: index + 1,
      pngUrl: approvedCurrent
        ? publicApprovedRenderUrl(storage!.client, run.id, run.currentVersion, index)
        : await signDraftRenderUrl(storage!.client, run.ownerId, run.id, run.currentVersion, index),
    })));
    return {
      generation: {
        id: run.id,
        processingStatus: run.processingStatus,
        reviewStatus: run.reviewStatus,
        deliveryStatus: run.deliveryStatus,
        version: run.currentVersion,
        approvedVersion: run.approvedVersion,
        canDownload: approvedCurrent,
        statusPath: `/api/v1/generations/${encodeURIComponent(run.id)}`,
        reviewPath: `/#/editor/${encodeURIComponent(row.id)}?review=1`,
      },
      design: {
        id: row.id,
        name: row.name,
        pageCount: total,
        editorPath: `/#/editor/${encodeURIComponent(row.id)}`,
        reviewPath: `/#/editor/${encodeURIComponent(row.id)}?review=1`,
        pages,
      },
    };
  }

  app.post<{ Body: GenerationBody }>("/api/v1/generations", async (request, reply) => {
    if (!storage) return reply.code(501).send({ error: "Storage is not configured on this server" });
    const principal = await requirePrincipal(request, reply);
    if (!principal) return;
    const { ownerId } = principal;
    const rawKey = request.headers["idempotency-key"];
    if (typeof rawKey !== "string" || !rawKey.trim()) {
      return reply.code(400).send({ error: "missing required header: Idempotency-Key" });
    }
    const idempotencyKey = rawKey.trim();
    if (idempotencyKey.length > 200) return reply.code(400).send({ error: "Idempotency-Key must be at most 200 characters" });

    const { template, name, pages, run_id: runId } = request.body ?? {};
    if (!template || !name?.trim() || !Array.isArray(pages)) {
      return reply.code(400).send({ error: "missing required field: template, name, pages" });
    }
    if (runId !== undefined && typeof runId !== "string") return reply.code(400).send({ error: "run_id must be a string" });
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
        if (value.asset !== undefined && value.image_url !== undefined) {
          return reply.code(400).send({ error: `pages[${index}].layers.${layerName} cannot contain both asset and image_url` });
        }
      }
    }

    const requestHash = hashJson({ template, name: name.trim(), pages, run_id: runId ?? null });
    const existingByKey = await generations.findByIdempotency(ownerId, idempotencyKey);
    if (existingByKey && existingByKey.requestHash !== requestHash) {
      return reply.code(409).send({
        error: "IDEMPOTENCY_CONFLICT",
        message: "this Idempotency-Key was already used with a different request body",
        generationId: existingByKey.id,
      });
    }

    const designId = generatedDesignId(ownerId, idempotencyKey);
    const genId = generationId(ownerId, idempotencyKey);
    let row = await deps.findTemplate(ownerId, designId);
    let run = existingByKey;
    let replay = Boolean(row || run);
    let preRendered: Buffer[] | null = null;
    let acquiredAssets: ResolvedMedia[] = [];

    if (!row) {
      const source = await deps.findTemplate(ownerId, template);
      if (!source) return reply.code(404).send({ error: `template not found: ${template}` });
      let document;
      try {
        // Validate names and layer types before making a paid/provider request.
        buildGeneratedDocument(source.document, name.trim(), pages);
        const resolved = await resolveGenerationMedia(ownerId, genId, pages);
        acquiredAssets = resolved.assets;
        document = buildGeneratedDocument(source.document, name.trim(), resolved.pages);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(err instanceof GenerationDocumentError ? 400 : 502).send({ error: message });
      }
      document.seedId = designId;
      try {
        preRendered = await renderAllPages(ownerId, document);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: `render failed: ${message}` });
      }
      try {
        row = await deps.createTemplate(ownerId, { id: designId, name: name.trim(), document });
      } catch (createError) {
        const concurrentWinner = await deps.findTemplate(ownerId, designId);
        if (!concurrentWinner) throw createError;
        row = concurrentWinner;
        replay = true;
        preRendered = null;
        acquiredAssets = [];
      }
    }

    if (!run) {
      try {
        run = await generations.createWithInitialVersion({
          id: genId,
          ownerId,
          designId: row.id,
          sourceTemplateId: template,
          idempotencyKey,
          requestHash,
          runId: runId ?? null,
          document: row.document,
          documentChecksum: hashJson(row.document),
          createdBy: principal.actorId,
        });
      } catch (createError) {
        const concurrentWinner = await generations.findByIdempotency(ownerId, idempotencyKey);
        if (!concurrentWinner) throw createError;
        if (concurrentWinner.requestHash !== requestHash) {
          return reply.code(409).send({ error: "IDEMPOTENCY_CONFLICT" });
        }
        run = concurrentWinner;
        replay = true;
      }
    }

    const currentVersion = await generations.findVersion(ownerId, run.id, run.currentVersion);
    if (currentVersion && hashJson(row.document) !== currentVersion.documentChecksum && run.reviewStatus !== "draft") {
      run = await generations.markEdited(ownerId, row.id) ?? run;
    }
    const renderDocument = run.reviewStatus === "approved" && run.approvedVersion === run.currentVersion && currentVersion
      ? currentVersion.document
      : row.document;
    try {
      const pngs = preRendered ?? await renderAllPages(ownerId, renderDocument);
      await Promise.all(pngs.map((png, index) =>
        uploadDraftRender(storage.client, ownerId, run!.id, run!.currentVersion, index, png)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `could not publish generated renders: ${message}` });
    }

    for (const asset of acquiredAssets) {
      await generations.recordMediaAsset({
        id: randomUUID(),
        ownerId,
        generationId: run.id,
        version: run.currentVersion,
        page: asset.page,
        layerName: asset.layerName,
        strategy: asset.request.strategy,
        storageRef: asset.storageRef,
        mimeType: asset.acquired.contentType,
        width: asset.acquired.width,
        height: asset.acquired.height,
        provider: asset.acquired.provider,
        externalId: asset.acquired.externalId,
        author: asset.acquired.author,
        attributionUrl: asset.acquired.attributionUrl,
        licenseUrl: asset.acquired.licenseUrl,
        prompt: asset.acquired.prompt,
        model: asset.acquired.model,
      });
    }

    return reply.code(replay ? 200 : 201).send(await generationPayload(run, row));
  });

  async function findOwnedGeneration(
    ownerId: string,
    generationId: string,
    reply: FastifyReply,
  ): Promise<{ run: GenerationRun; row: TemplateRow } | null> {
    const run = await generations.findById(ownerId, generationId);
    if (!run) {
      reply.code(404).send({ error: `generation not found: ${generationId}` });
      return null;
    }
    const row = await deps.findTemplate(ownerId, run.designId);
    if (!row) {
      reply.code(404).send({ error: `generated design not found: ${run.designId}` });
      return null;
    }
    return { run, row };
  }

  app.get<{ Params: { designId: string } }>("/api/v1/generations/by-design/:designId", async (request, reply) => {
    if (!storage) return reply.code(501).send({ error: "Storage is not configured on this server" });
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const run = await generations.findByDesign(ownerId, request.params.designId);
    if (!run) return reply.code(404).send({ error: `generation not found for design: ${request.params.designId}` });
    const row = await deps.findTemplate(ownerId, run.designId);
    if (!row) return reply.code(404).send({ error: `generated design not found: ${run.designId}` });
    return generationPayload(run, row);
  });

  app.get<{ Params: { id: string } }>("/api/v1/generations/:id", async (request, reply) => {
    if (!storage) return reply.code(501).send({ error: "Storage is not configured on this server" });
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const found = await findOwnedGeneration(ownerId, request.params.id, reply);
    if (!found) return;
    return generationPayload(found.run, found.row);
  });

  app.post<{ Params: { id: string } }>("/api/v1/generations/:id/submit", async (request, reply) => {
    if (!storage) return reply.code(501).send({ error: "Storage is not configured on this server" });
    const principal = await requireHuman(request, reply);
    if (!principal) return;
    const found = await findOwnedGeneration(principal.ownerId, request.params.id, reply);
    if (!found) return;
    const checksum = hashJson(found.row.document);
    const submitted = await generations.submitVersion({
      ownerId: principal.ownerId,
      generationId: found.run.id,
      document: found.row.document,
      documentChecksum: checksum,
      createdBy: principal.actorId!,
    });
    try {
      const pngs = await renderAllPages(principal.ownerId, found.row.document);
      await Promise.all(pngs.map((png, index) =>
        uploadDraftRender(storage.client, principal.ownerId, found.run.id, submitted.version.version, index, png)));
    } catch (err) {
      return reply.code(502).send({ error: `could not render review version: ${err instanceof Error ? err.message : String(err)}` });
    }
    return generationPayload(submitted.generation, found.row);
  });

  app.post<{ Params: { id: string }; Body: { version?: number } }>(
    "/api/v1/generations/:id/approve",
    async (request, reply) => {
      if (!storage) return reply.code(501).send({ error: "Storage is not configured on this server" });
      const principal = await requireHuman(request, reply);
      if (!principal) return;
      const found = await findOwnedGeneration(principal.ownerId, request.params.id, reply);
      if (!found) return;
      const expectedVersion = request.body?.version ?? found.run.currentVersion;
      if (!Number.isInteger(expectedVersion) || expectedVersion !== found.run.currentVersion) {
        return reply.code(409).send({ error: "STALE_VERSION", currentVersion: found.run.currentVersion });
      }
      const approvalReplay = found.run.reviewStatus === "approved" && found.run.approvedVersion === expectedVersion;
      if (found.run.reviewStatus !== "pending" && !approvalReplay) {
        return reply.code(409).send({ error: "generation is not awaiting approval", reviewStatus: found.run.reviewStatus });
      }
      const version = await generations.findVersion(principal.ownerId, found.run.id, expectedVersion);
      if (!version) return reply.code(409).send({ error: "STALE_VERSION" });
      if (hashJson(found.row.document) !== version.documentChecksum) {
        await generations.markEdited(principal.ownerId, found.row.id);
        return reply.code(409).send({ error: "STALE_VERSION", message: "the design changed after it was submitted" });
      }

      let pngs: Buffer[];
      try {
        pngs = await renderAllPages(principal.ownerId, version.document);
        await Promise.all(pngs.map((png, index) =>
          uploadApprovedRender(storage.client, found.run.id, version.version, index, png)));
      } catch (err) {
        return reply.code(502).send({ error: `could not publish approved renders: ${err instanceof Error ? err.message : String(err)}` });
      }
      const approvedUrls = pngs.map((png, index) => ({
        page: index + 1,
        storagePath: publicApprovedRenderUrl(storage.client, found.run.id, version.version, index),
        checksum: createHash("sha256").update(png).digest("hex"),
      }));
      const decision = approvalReplay ? { generation: found.run } : await generations.recordDecision({
        ownerId: principal.ownerId,
        generationId: found.run.id,
        version: version.version,
        action: "approved",
        actorId: principal.actorId!,
      });
      await generations.recordApprovedRenders({
        ownerId: principal.ownerId,
        generationId: found.run.id,
        version: version.version,
        renders: approvedUrls,
      });
      return generationPayload(decision.generation, found.row);
    },
  );

  app.post<{ Params: { id: string }; Body: { version?: number; comment?: string; action?: "changes_requested" | "rejected" } }>(
    "/api/v1/generations/:id/request-changes",
    async (request, reply) => {
      const principal = await requireHuman(request, reply);
      if (!principal) return;
      const found = await findOwnedGeneration(principal.ownerId, request.params.id, reply);
      if (!found) return;
      const version = request.body?.version ?? found.run.currentVersion;
      const comment = request.body?.comment?.trim();
      if (!comment) return reply.code(400).send({ error: "comment is required when requesting changes" });
      if (version !== found.run.currentVersion || found.run.reviewStatus !== "pending") {
        return reply.code(409).send({ error: "STALE_VERSION", currentVersion: found.run.currentVersion });
      }
      const action = request.body?.action === "rejected" ? "rejected" : "changes_requested";
      const decision = await generations.recordDecision({
        ownerId: principal.ownerId,
        generationId: found.run.id,
        version,
        action,
        comment,
        actorId: principal.actorId!,
      });
      return { generation: decision.generation, approval: decision.approval };
    },
  );

  app.post<{
    Params: { id: string; page: string; layer: string };
    Body: MediaAssetRequest;
  }>("/api/v1/generations/:id/media/:page/:layer/regenerate", async (request, reply) => {
    if (!storage) return reply.code(501).send({ error: "Storage is not configured on this server" });
    if (!media) return reply.code(501).send({ error: "media acquisition is not configured on this server" });
    const principal = await requireHuman(request, reply);
    if (!principal) return;
    const found = await findOwnedGeneration(principal.ownerId, request.params.id, reply);
    if (!found) return;
    const page = Number(request.params.page);
    const document = found.row.document as { pages?: Array<{ els?: Array<{ name?: string; type?: string }> }> };
    if (!Number.isInteger(page) || page < 1 || page > (document.pages?.length ?? 0)) {
      return reply.code(400).send({ error: "page is outside the design" });
    }
    const element = document.pages?.[page - 1]?.els?.find((item) => item.name === request.params.layer);
    if (!element || element.type !== "image") {
      return reply.code(400).send({ error: `unknown image layer: ${request.params.layer}` });
    }
    let mediaRequest: MediaAssetRequest;
    try {
      mediaRequest = parseMediaRequest(request.body, "body");
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    let acquired: AcquiredMedia;
    let storageRef: string;
    try {
      acquired = await media.service.acquire(mediaRequest);
      storageRef = await uploadUserPhoto(
        storage.client,
        principal.ownerId,
        `${found.run.id}-page-${page}-${request.params.layer}.${acquired.extension}`,
        acquired.contentType,
        acquired.bytes,
      );
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const updatedDocument = applyLayerOverrides(
      found.row.document,
      parseLayers({ [request.params.layer]: { image_url: storageRef } }),
      page - 1,
    );
    const updatedRow = await deps.updateTemplate(principal.ownerId, found.row.id, { document: updatedDocument });
    if (!updatedRow) return reply.code(404).send({ error: `generated design not found: ${found.row.id}` });
    const submitted = await generations.submitVersion({
      ownerId: principal.ownerId,
      generationId: found.run.id,
      document: updatedDocument,
      documentChecksum: hashJson(updatedDocument),
      createdBy: principal.actorId!,
    });
    await generations.recordMediaAsset({
      id: randomUUID(), ownerId: principal.ownerId, generationId: found.run.id,
      version: submitted.version.version, page, layerName: request.params.layer,
      strategy: mediaRequest.strategy, storageRef, mimeType: acquired.contentType,
      width: acquired.width, height: acquired.height, provider: acquired.provider,
      externalId: acquired.externalId, author: acquired.author, attributionUrl: acquired.attributionUrl,
      licenseUrl: acquired.licenseUrl, prompt: acquired.prompt, model: acquired.model,
    });
    try {
      const pngs = await renderAllPages(principal.ownerId, updatedDocument);
      await Promise.all(pngs.map((png, index) =>
        uploadDraftRender(storage.client, principal.ownerId, found.run.id, submitted.version.version, index, png)));
    } catch (err) {
      return reply.code(502).send({ error: `could not render regenerated media: ${err instanceof Error ? err.message : String(err)}` });
    }
    return generationPayload(submitted.generation, updatedRow);
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
    // Designs comuns mantêm o link legado determinístico. Em uma geração gerenciada, nenhum
    // caminho público é revelado antes de a versão atual ser aprovada; depois disso apontamos
    // para o snapshot imutável aprovado, não para a cópia editável.
    const managed = storage ? await generations.findByDesign(ownerId, row.id) : null;
    const approvedCurrent = managed?.reviewStatus === "approved" && managed.approvedVersion === managed.currentVersion;
    const downloadUrl = storage
      ? managed
        ? approvedCurrent
          ? publicApprovedRenderUrl(storage.client, managed.id, managed.currentVersion, 0)
          : undefined
        : publicRenderUrl(storage.client, row.id)
      : undefined;
    return { id: row.id, name: row.name, document: row.document, downloadUrl, favorite: row.favorite };
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

  app.put<{ Params: { id: string }; Body: { name?: string; document?: unknown; favorite?: boolean } }>(
    "/api/v1/templates/:id",
    async (request, reply) => {
      const ownerId = await requireOwner(request, reply);
      if (!ownerId) return;
      const before = request.body?.document !== undefined
        ? await deps.findTemplate(ownerId, request.params.id)
        : null;
      const row = await deps.updateTemplate(ownerId, request.params.id, request.body ?? {});
      if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      if (request.body?.document !== undefined && before && hashJson(before.document) !== hashJson(row.document)) {
        await generations.markEdited(ownerId, row.id);
      }
      return { id: row.id, name: row.name, favorite: row.favorite };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/templates/:id", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const deleted = await deps.deleteTemplate(ownerId, request.params.id);
    if (!deleted) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
    return reply.code(204).send();
  });

  // Histórico de versão nomeado (Editar → Histórico) — diferente do versionamento automático
  // de gerações (generationWorkflow.ts): manual, iniciado pela pessoa, por template_id em vez
  // de generation_id. Cada versão é um snapshot imutável; "restaurar" e "duplicar" nunca
  // reescrevem a linha, só leem o document dela.
  app.get<{ Params: { id: string } }>("/api/v1/templates/:id/versions", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const row = await deps.findTemplate(ownerId, request.params.id);
    if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
    return deps.listDesignVersions(ownerId, row.id);
  });

  // Leitura de uma versão específica, incluindo o `document` — usado pelo botão "Exportar"
  // do histórico (item 3.1b): renderiza o snapshot em HTML sem restaurar nem duplicar nada.
  app.get<{ Params: { id: string; versionId: string } }>(
    "/api/v1/templates/:id/versions/:versionId",
    async (request, reply) => {
      const ownerId = await requireOwner(request, reply);
      if (!ownerId) return;
      const row = await deps.findTemplate(ownerId, request.params.id);
      if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      const version = await deps.findDesignVersion(ownerId, row.id, request.params.versionId);
      if (!version) return reply.code(404).send({ error: `version not found: ${request.params.versionId}` });
      return { id: version.id, name: version.name, createdAt: version.createdAt, document: version.document };
    },
  );

  app.post<{ Params: { id: string }; Body: { name?: string } }>(
    "/api/v1/templates/:id/versions",
    async (request, reply) => {
      const ownerId = await requireOwner(request, reply);
      if (!ownerId) return;
      const name = request.body?.name?.trim();
      if (!name) return reply.code(400).send({ error: "missing required field: name" });
      const row = await deps.findTemplate(ownerId, request.params.id);
      if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      const version = await deps.createDesignVersion(ownerId, { templateId: row.id, name, document: row.document });
      return reply.code(201).send(version);
    },
  );

  app.post<{ Params: { id: string; versionId: string } }>(
    "/api/v1/templates/:id/versions/:versionId/restore",
    async (request, reply) => {
      const ownerId = await requireOwner(request, reply);
      if (!ownerId) return;
      const row = await deps.findTemplate(ownerId, request.params.id);
      if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      const version = await deps.findDesignVersion(ownerId, row.id, request.params.versionId);
      if (!version) return reply.code(404).send({ error: `version not found: ${request.params.versionId}` });
      const updated = await deps.updateTemplate(ownerId, row.id, { document: version.document });
      if (!updated) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      await generations.markEdited(ownerId, row.id);
      return { id: updated.id, name: updated.name };
    },
  );

  app.post<{ Params: { id: string; versionId: string } }>(
    "/api/v1/templates/:id/versions/:versionId/duplicate",
    async (request, reply) => {
      const ownerId = await requireOwner(request, reply);
      if (!ownerId) return;
      const row = await deps.findTemplate(ownerId, request.params.id);
      if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      const version = await deps.findDesignVersion(ownerId, row.id, request.params.versionId);
      if (!version) return reply.code(404).send({ error: `version not found: ${request.params.versionId}` });
      // Duplicar uma versão cria um DESIGN NOVO e independente a partir daquele snapshot — não
      // mexe no design original nem na própria versão. Mesmo padrão de "Duplicar" em um design
      // inteiro (store.ts, duplicateTemplate), só que a partir de um ponto no passado.
      const created = await deps.createTemplate(ownerId, { name: `${row.name} (${version.name})`, document: version.document });
      return reply.code(201).send({ id: created.id, name: created.name });
    },
  );

  app.delete<{ Params: { id: string; versionId: string } }>(
    "/api/v1/templates/:id/versions/:versionId",
    async (request, reply) => {
      const ownerId = await requireOwner(request, reply);
      if (!ownerId) return;
      const row = await deps.findTemplate(ownerId, request.params.id);
      if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      const deleted = await deps.deleteDesignVersion(ownerId, row.id, request.params.versionId);
      if (!deleted) return reply.code(404).send({ error: `version not found: ${request.params.versionId}` });
      return reply.code(204).send();
    },
  );

  // Compartilhamento (Editar → Compartilhar): "private" por padrão — sempre existiu antes de
  // qualquer coisa ficar pública, nunca o contrário. As duas rotas abaixo são do DONO
  // (requireOwner); a leitura anônima vive só nas rotas /api/v1/public/* mais abaixo, que
  // conferem a visibilidade ANTES de qualquer documento sair — nunca herdam a autenticação
  // daqui.
  // O app inteiro roteia por hash (`location.hash = "/" + rota`, ver src/router.ts) — não existe
  // rota de servidor pra `/p/:id` de verdade, então o link só funciona como `/#/p/:id`: o
  // navegador sempre carrega o mesmo index.html, e é o hash que diz pro SPA mostrar a visão
  // pública em vez de console/editor.
  function publicShareUrl(id: string): string {
    return `/#/p/${encodeURIComponent(id)}`;
  }

  app.get<{ Params: { id: string } }>("/api/v1/templates/:id/share", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const row = await deps.findTemplate(ownerId, request.params.id);
    if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
    const visibility = await deps.getDesignShareVisibility(ownerId, row.id);
    return { visibility, publicUrl: visibility === "link" ? publicShareUrl(row.id) : null };
  });

  app.post<{ Params: { id: string }; Body: { visibility?: string } }>(
    "/api/v1/templates/:id/share",
    async (request, reply) => {
      const ownerId = await requireOwner(request, reply);
      if (!ownerId) return;
      const visibility = request.body?.visibility;
      if (visibility !== "private" && visibility !== "link") {
        return reply.code(400).send({ error: 'visibility must be "private" or "link"' });
      }
      const row = await deps.findTemplate(ownerId, request.params.id);
      if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      await deps.setDesignShareVisibility(ownerId, row.id, visibility);
      return { visibility, publicUrl: visibility === "link" ? publicShareUrl(row.id) : null };
    },
  );

  // --- Comentários fixados no canvas (Editar → Comentários, item 4.3) ------------------------
  // Do design inteiro (owner_id + template_id), não de uma versão — restaurar uma versão antiga
  // não apaga a discussão. Sem conceito de time/colaborador convidado neste app ainda, então é
  // sempre o próprio dono comentando pra si mesmo — ver a nota na migration 0009.
  app.get<{ Params: { id: string } }>("/api/v1/templates/:id/comments", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const row = await deps.findTemplate(ownerId, request.params.id);
    if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
    return deps.listDesignComments(ownerId, row.id);
  });

  app.post<{ Params: { id: string }; Body: { pageIndex?: number; x?: number; y?: number; body?: string } }>(
    "/api/v1/templates/:id/comments",
    async (request, reply) => {
      const ownerId = await requireOwner(request, reply);
      if (!ownerId) return;
      const { pageIndex = 0, x, y, body } = request.body ?? {};
      if (typeof x !== "number" || typeof y !== "number") {
        return reply.code(400).send({ error: "x and y (0..1, relative to the page) are required" });
      }
      if (!body?.trim()) return reply.code(400).send({ error: "missing required field: body" });
      const row = await deps.findTemplate(ownerId, request.params.id);
      if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      const comment = await deps.createDesignComment(ownerId, { templateId: row.id, pageIndex, x, y, body: body.trim() });
      return reply.code(201).send(comment);
    },
  );

  app.post<{ Params: { id: string; commentId: string } }>(
    "/api/v1/templates/:id/comments/:commentId/resolve",
    async (request, reply) => {
      const ownerId = await requireOwner(request, reply);
      if (!ownerId) return;
      const row = await deps.findTemplate(ownerId, request.params.id);
      if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      const ok = await deps.setDesignCommentResolved(ownerId, row.id, request.params.commentId, true);
      if (!ok) return reply.code(404).send({ error: `comment not found: ${request.params.commentId}` });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string; commentId: string } }>(
    "/api/v1/templates/:id/comments/:commentId/reopen",
    async (request, reply) => {
      const ownerId = await requireOwner(request, reply);
      if (!ownerId) return;
      const row = await deps.findTemplate(ownerId, request.params.id);
      if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      const ok = await deps.setDesignCommentResolved(ownerId, row.id, request.params.commentId, false);
      if (!ok) return reply.code(404).send({ error: `comment not found: ${request.params.commentId}` });
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; commentId: string } }>(
    "/api/v1/templates/:id/comments/:commentId",
    async (request, reply) => {
      const ownerId = await requireOwner(request, reply);
      if (!ownerId) return;
      const row = await deps.findTemplate(ownerId, request.params.id);
      if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      const ok = await deps.deleteDesignComment(ownerId, row.id, request.params.commentId);
      if (!ok) return reply.code(404).send({ error: `comment not found: ${request.params.commentId}` });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string; commentId: string }; Body: { body?: string } }>(
    "/api/v1/templates/:id/comments/:commentId/replies",
    async (request, reply) => {
      const ownerId = await requireOwner(request, reply);
      if (!ownerId) return;
      const body = request.body?.body?.trim();
      if (!body) return reply.code(400).send({ error: "missing required field: body" });
      const row = await deps.findTemplate(ownerId, request.params.id);
      if (!row) return reply.code(404).send({ error: `template not found: ${request.params.id}` });
      const created = await deps.createDesignCommentReply(ownerId, row.id, request.params.commentId, body);
      if (!created) return reply.code(404).send({ error: `comment not found: ${request.params.commentId}` });
      return reply.code(201).send(created);
    },
  );

  // --- Leitura pública, sem autenticação nenhuma (Editar → Compartilhar → link) --------------
  // Nenhuma rota daqui pra baixo chama requireOwner/requirePrincipal — de propósito, é assim
  // que um visitante anônimo com o link consegue ver o design. A única porta de entrada é
  // `getPublicShareVisibility`: quem não está marcado "link" responde 404 igual a design
  // inexistente, pra não revelar "existe mas é privado" pra quem está só adivinhando ids.
  async function requirePublicTemplate(id: string, reply: FastifyReply): Promise<TemplateRow | null> {
    const visibility = await deps.getPublicShareVisibility(id);
    if (visibility !== "link") {
      reply.code(404).send({ error: `design not found: ${id}` });
      return null;
    }
    const row = await deps.findTemplatePublic(id);
    if (!row) {
      reply.code(404).send({ error: `design not found: ${id}` });
      return null;
    }
    return row;
  }

  app.get<{ Params: { id: string } }>("/api/v1/public/designs/:id", async (request, reply) => {
    const row = await requirePublicTemplate(request.params.id, reply);
    if (!row) return;
    return { id: row.id, name: row.name, pageCount: pageCount(row.document) };
  });

  app.get<{ Params: { id: string; page: string } }>("/api/v1/public/designs/:id/page/:page", async (request, reply) => {
    const row = await requirePublicTemplate(request.params.id, reply);
    if (!row) return;
    const page = Number(request.params.page);
    const total = pageCount(row.document);
    if (!Number.isInteger(page) || page < 1 || page > total) {
      return reply.code(400).send({ error: `page must be an integer between 1 and ${total}` });
    }
    try {
      // Faces do dono, não de quem está vendo (que não tem dono nenhum) — o design carrega a
      // fonte que precisa em `Doc.fonts` quando importado de um PDF; faces extras do dono só
      // importam pra um design que ainda depende de fonte registrada fora do documento.
      const faces = await facesDoRegistry(row.ownerId);
      const png = await deps.renderTemplatePng(row.document, parseLayers({}), page - 1, faces);
      return reply.header("content-type", "image/png").header("cache-control", "public, max-age=60").send(png);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
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

  // Sobe cada imagem extraída do PDF pro bucket privado do dono e devolve o mapa
  // imageId -> src, na mesma referência que uma layer de imagem já usa (uploadUserPhoto).
  async function uploadImportedImages(ownerId: string, images: ImportedImage[]): Promise<Map<string, string>> {
    const bySrc = new Map<string, string>();
    for (const image of images) {
      const ext = image.contentType === "image/png" ? "png" : "jpg";
      const src = await uploadUserPhoto(storage!.client, ownerId, `${image.id}.${ext}`, image.contentType, image.bytes);
      bySrc.set(image.id, src);
    }
    return bySrc;
  }

  // Mesmo par uploadFontFace+upsertFontFace que POST /api/v1/fonts usa, só que chamado direto em
  // vez de via HTTP — este código já roda com a identidade do dono, sem precisar de uma chave de
  // API pra falar consigo mesmo. O sha256 é recalculado aqui pela mesma razão que em
  // POST /api/v1/fonts: é a identidade da face, nunca aceita do que o PDF/microsserviço disser.
  async function registerImportedFonts(ownerId: string, fonts: ImportedFont[]) {
    return Promise.all(fonts.map(async (font) => {
      const sha256 = createHash("sha256").update(font.ttf).digest("hex");
      const { sfntPath, woff2Path } = await uploadFontFace(storage!.client, sha256, { ext: "ttf", bytes: font.ttf }, font.woff2);
      await deps.upsertFontFace({
        id: randomUUID(),
        ownerId,
        sha256,
        internalFamily: font.familia,
        postscriptName: font.postscriptName ?? null,
        weight: font.peso,
        style: font.estilo,
        sfntPath,
        woff2Path,
      });
      return { family: font.familia, weight: font.peso, sha256, woff2: woff2Path, ttf: sfntPath, glyphs: font.glifos };
    }));
  }

  /**
   * Melhora, quando possível, blocos que o Fix 2 (canva-pdf-fonts.py) já trocou por Inter
   * porque não conseguiu reconstruir a fonte original — pergunta a uma IA (googleFonts.match)
   * qual Google Font parece com o que a arte usava e, se achar, baixa e registra essa face
   * (googleFonts.fetchFace), trocando `font`/`weight` só NESSE elemento.
   *
   * Estritamente aditivo: sem `googleFonts` configurado, sem match, ou sem conseguir baixar a
   * face, os elementos ficam exatamente como o Fix 2 já deixa hoje (Inter) — nenhuma etapa
   * daqui pode fazer um import que funcionava parar de funcionar.
   */
  async function upgradeFallbackFontsWithGoogleMatch(
    ownerId: string, pages: ImportedPage[],
  ): Promise<{
    pages: ImportedPage[];
    fonts: Array<{ family: string; weight: number; sha256: string; ttf: string; woff2: string; glyphs?: string }>;
  }> {
    if (!googleFonts) return { pages, fonts: [] };
    type Face = { family: string; weight: number; sha256: string; ttf: string; woff2: string };
    // Guarda a PROMESSA, não o resultado: várias camadas concorrentes pedindo a mesma família+
    // peso (comum numa página com vários blocos em fallback) chegariam aqui todas com
    // `registradas.get(chaveFace)` ainda vazio se só o valor resolvido fosse cacheado — cada
    // uma baixaria/subiria/registraria a MESMA face em paralelo. Cachear a promessa faz a
    // segunda chamada esperar a primeira em vez de duplicar o trabalho.
    const registradas = new Map<string, Promise<Face | null>>();

    function obterOuBaixarFace(escolhida: FontMatch): Promise<Face | null> {
      const chaveFace = `${escolhida.family}::${escolhida.weight}`;
      let promessa = registradas.get(chaveFace);
      if (!promessa) {
        promessa = (async () => {
          const baixada = await googleFonts!.fetchFace(escolhida.family, escolhida.weight).catch(() => null);
          if (!baixada) return null;
          const { sfntPath, woff2Path } = await uploadFontFace(
            storage!.client, baixada.sha256, { ext: "ttf", bytes: baixada.ttf }, baixada.woff2);
          await deps.upsertFontFace({
            id: randomUUID(), ownerId, sha256: baixada.sha256,
            internalFamily: escolhida.family, weight: escolhida.weight, style: "Regular",
            sfntPath, woff2Path,
          });
          return { family: escolhida.family, weight: escolhida.weight, sha256: baixada.sha256, ttf: sfntPath, woff2: woff2Path };
        })();
        registradas.set(chaveFace, promessa);
      }
      return promessa;
    }

    const novasPaginas = await Promise.all(pages.map(async (page) => {
      const textos = page.elements.filter((el): el is Extract<typeof el, { type: "text" }> => el.type === "text");
      const pistas: FontMatchHint[] = textos
        .filter((el) => el.fontOriginal)
        .map((el) => ({ chave: el.fontOriginal!, bbox: { x: el.x, y: el.y, w: el.w, h: el.h } }));
      if (!pistas.length || !page.previewPng) return page;

      const matches = await googleFonts!.match(page.previewPng, pistas).catch(() => new Map<string, FontMatch>());
      if (!matches.size) return page;

      const elements = await Promise.all(page.elements.map(async (el) => {
        if (el.type !== "text" || !el.fontOriginal) return el;
        const escolhida = matches.get(el.fontOriginal);
        if (!escolhida) return el;
        const face = await obterOuBaixarFace(escolhida);
        if (!face) return el;
        return { ...el, font: face.family, weight: face.weight };
      }));
      return { ...page, elements };
    }));

    const resolvidas = await Promise.all(registradas.values());
    const fonts = resolvidas.filter((f): f is Face => f !== null);
    return { pages: novasPaginas, fonts };
  }

  // Junta páginas+elementos do microsserviço num Doc do editor (src/types.ts). Cada El exige um
  // conjunto de campos que a extração não tem motivo pra saber (rot/opacity/locked/...) — os
  // mesmos defaults que canva-import.ts já usa para o caminho manual de importação.
  function buildImportedPages(pages: ImportedPage[], imageSrcById: Map<string, string>) {
    return pages.map((page) => ({
      id: randomUUID(),
      w: page.w,
      h: page.h,
      bg: page.bg,
      els: page.elements.map((el, index) => {
        if (el.type === "image") {
          const src = imageSrcById.get(el.imageId);
          if (!src) throw new Error(`imagem não encontrada para o elemento: ${el.imageId}`);
          return {
            id: randomUUID(), type: "image" as const, name: el.name,
            x: el.x, y: el.y, w: el.w, h: el.h,
            rot: 0, opacity: 1, locked: false, hidden: false,
            fill: "", stroke: "", strokeWidth: 0, radius: 0,
            src,
          };
        }
        if (el.type === "rect") {
          return {
            id: randomUUID(), type: "rect" as const, name: `forma ${index + 1}`,
            x: el.x, y: el.y, w: el.w, h: el.h,
            rot: 0, opacity: el.opacity, locked: false, hidden: false,
            fill: el.fill, stroke: "", strokeWidth: 0, radius: 0,
          };
        }
        if (el.type === "path") {
          return {
            id: randomUUID(), type: "draw" as const, name: `desenho ${index + 1}`,
            x: el.x, y: el.y, w: el.w, h: el.h,
            rot: 0, opacity: el.opacity, locked: false, hidden: false,
            fill: el.fill, stroke: "", strokeWidth: 0, radius: 0,
            fillPath: el.fillPath,
          };
        }
        return {
          id: randomUUID(), type: "text" as const, name: `texto ${index + 1}`,
          x: el.x, y: el.y, w: el.w, h: el.h,
          rot: el.rot, opacity: 1, locked: false, hidden: false,
          fill: el.fill, stroke: "", strokeWidth: 0, radius: 0,
          text: el.text, font: el.font, weight: el.weight, size: el.size,
          // `lh` não é opcional na prática: o render em canvas (editor.ts) faz `size * lh` pra
          // posicionar cada linha — undefined vira NaN, e `fillText` com coordenada NaN não
          // desenha nada, em silêncio (achado exportando um design importado de verdade: a foto
          // saía, o texto sumia). 1.25 é o valor que os outros textos deste projeto já usam.
          lh: 1.25, align: "left",
        };
      }),
    }));
  }

  // Síncrona (mesmo padrão de /api/v1/generations): o navegador espera até terminar, ~1min pra
  // um carrossel — sem fila nem polling, porque a extração em si não é lenta o bastante pra
  // justificar a complexidade de um job assíncrono.
  app.post("/api/v1/imports/pdf", async (request, reply) => {
    if (!storage) return reply.code(501).send({ error: "Storage is not configured on this server" });
    if (!pdfImport) return reply.code(501).send({ error: "PDF import is not configured on this server" });
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;

    const file = await request.file();
    if (!file || file.fieldname !== "pdf") return reply.code(400).send({ error: "envie o campo 'pdf' como multipart" });
    const bytes = await file.toBuffer();
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return reply.code(400).send({ error: "arquivo não é um PDF" });

    let result;
    try {
      result = await pdfImport.service.importPdf(bytes);
    } catch (err) {
      if (err instanceof FlattenedPdfError) return reply.code(422).send({ error: err.message, codigo: "achatado" });
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }

    let row;
    let pages;
    let fonts;
    try {
      const imageSrcById = await uploadImportedImages(ownerId, result.images);
      fonts = await registerImportedFonts(ownerId, result.fonts);
      // Depois de registrar as fontes reconstruídas do PDF: tenta melhorar os blocos que ainda
      // ficaram em Inter (fallback do Fix 2) para uma Google Font parecida — devolve páginas
      // NOVAS (não muta `result.pages`), então `buildImportedPages` precisa ler a partir daqui.
      const upgrade = await upgradeFallbackFontsWithGoogleMatch(ownerId, result.pages);
      fonts = [...fonts, ...upgrade.fonts];
      pages = buildImportedPages(upgrade.pages, imageSrcById);
      const name = file.filename?.replace(/\.pdf$/i, "").trim() || "PDF importado";
      const document = { name, active: 0, pages, ...(fonts.length ? { fonts } : {}) };
      row = await deps.createTemplate(ownerId, { name, document });
    } catch (err) {
      // Sem isto, um erro daqui em diante (upload de imagem/fonte, montagem das páginas, criar o
      // template) virava um 500 cru do Fastify sem mensagem nenhuma — o logger deste app está
      // desligado (ver `Fastify({...})` acima), então nem no terminal do servidor sobrava rastro.
      request.log?.error?.(err);
      console.error("[imports/pdf] falhou depois da extração:", err);
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return reply.code(201).send({
      id: row.id,
      name: row.name,
      pageCount: pages.length,
      layerCount: pages.reduce((sum, page) => sum + page.els.length, 0),
      fontCount: fonts.length,
      flaggedPages: result.flaggedPages,
    });
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

  // --- Painel de design system/marca (Editar → Marca, item 4.7) ------------------------------
  // POR CONTA, não por design — igual às chaves de API acima, por isso as rotas não vivem sob
  // /templates/:id/ — o mesmo kit vale pra qualquer design que o dono abrir.
  app.get("/api/v1/brand-kits", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    return deps.listBrandKits(ownerId);
  });

  app.post<{ Body: { name?: string; colors?: string[]; fonts?: string[] } }>("/api/v1/brand-kits", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const name = request.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: "missing required field: name" });
    const colors = Array.isArray(request.body?.colors) ? request.body.colors : [];
    const fonts = Array.isArray(request.body?.fonts) ? request.body.fonts : [];
    const kit = await deps.createBrandKit(ownerId, { name, colors, fonts });
    return reply.code(201).send(kit);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/brand-kits/:id", async (request, reply) => {
    const ownerId = await requireOwner(request, reply);
    if (!ownerId) return;
    const deleted = await deps.deleteBrandKit(ownerId, request.params.id);
    if (!deleted) return reply.code(404).send({ error: `brand kit not found: ${request.params.id}` });
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
