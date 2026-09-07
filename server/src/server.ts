import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildApp, type AppDeps, type AuthDeps, type MediaDeps, type PdfImportDeps, type StorageDeps } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import { createSupabaseAuthClient } from "./supabaseAuth.ts";
import { createStorageClient } from "./storage.ts";
import {
  createDb,
  createBrandKit,
  createDesignComment,
  createDesignCommentReply,
  createDesignVersion,
  createPostgresGenerationRepository,
  createApiKey,
  createTemplate,
  deleteApiKey,
  deleteBrandKit,
  deleteDesignComment,
  deleteDesignVersion,
  deleteTemplate,
  findApiKeyOwner,
  findDesignVersion,
  findTemplate,
  findTemplatePublic,
  getDesignShareVisibility,
  getPublicShareVisibility,
  listApiKeys,
  listBrandKits,
  listDesignComments,
  listDesignVersions,
  listFontFaces,
  listTemplates,
  revokeApiKey,
  setDesignCommentResolved,
  setDesignShareVisibility,
  updateTemplate,
  upsertFontFace,
} from "./db.ts";
import { buscarCuradoriaPorTema } from "./curadoria.ts";
import { createLocalDeps } from "./local.ts";
import { configureStorageClient, renderTemplatePng } from "./render/renderTweet.ts";
import { configureFontStorage } from "./render/fontCache.ts";
import { createMediaAcquisitionService } from "./mediaAcquisition.ts";
import { createHttpPdfImportService } from "./pdfImportService.ts";

// Só em dev: `.env` não existe em produção (env vars vêm injetadas pelo runtime lá), e não faz
// sentido nenhum exigir esse arquivo pra rodar o servidor de verdade — daí o existsSync antes.
if (existsSync(".env")) process.loadEnvFile(".env");

const PORT = Number(process.env.PORT ?? 8787);
const DATABASE_URL = process.env.DATABASE_URL;
const LOCAL_API_KEY = process.env.LOCAL_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL;
const PDF_IMPORT_SERVICE_URL = process.env.PDF_IMPORT_SERVICE_URL;
const PDF_IMPORT_SERVICE_SECRET = process.env.PDF_IMPORT_SERVICE_SECRET;

if (!DATABASE_URL && !LOCAL_API_KEY) {
  console.error("DATABASE_URL is required in production; use LOCAL_API_KEY for local development");
  process.exit(1);
}

let deps: AppDeps;
if (DATABASE_URL) {
  const sql = createDb(DATABASE_URL);
  deps = {
    generations: createPostgresGenerationRepository(sql),
    findApiKeyOwner: (keyHash) => findApiKeyOwner(sql, keyHash),
    findTemplate: (ownerId, id) => findTemplate(sql, ownerId, id),
    listTemplates: (ownerId) => listTemplates(sql, ownerId),
    createTemplate: (ownerId, { id, name, document }) =>
      createTemplate(sql, { id: id ?? randomUUID(), ownerId, kind: "custom", name, document }),
    updateTemplate: (ownerId, id, input) => updateTemplate(sql, ownerId, id, input),
    deleteTemplate: (ownerId, id) => deleteTemplate(sql, ownerId, id),
    listApiKeys: (ownerId) => listApiKeys(sql, ownerId),
    createApiKey: async (ownerId, name) => {
      const secret = `blk_live_${randomUUID().replace(/-/g, "")}`;
      const created = await createApiKey(sql, { id: randomUUID(), ownerId, name, keyHash: hashApiKey(secret) });
      return { ...created, secret };
    },
    revokeApiKey: (ownerId, id) => revokeApiKey(sql, ownerId, id),
    upsertFontFace: (input) => upsertFontFace(sql, input),
    listFontFaces: (ownerId) => listFontFaces(sql, ownerId),
    deleteApiKey: (ownerId, id) => deleteApiKey(sql, ownerId, id),
    renderTemplatePng,
    listDesignVersions: (ownerId, templateId) => listDesignVersions(sql, ownerId, templateId),
    createDesignVersion: (ownerId, input) => createDesignVersion(sql, { id: randomUUID(), ownerId, ...input }),
    findDesignVersion: (ownerId, templateId, id) => findDesignVersion(sql, ownerId, templateId, id),
    deleteDesignVersion: (ownerId, templateId, id) => deleteDesignVersion(sql, ownerId, templateId, id),
    getDesignShareVisibility: (ownerId, templateId) => getDesignShareVisibility(sql, ownerId, templateId),
    setDesignShareVisibility: (ownerId, templateId, visibility) => setDesignShareVisibility(sql, ownerId, templateId, visibility),
    getPublicShareVisibility: (templateId) => getPublicShareVisibility(sql, templateId),
    findTemplatePublic: (id) => findTemplatePublic(sql, id),
    listDesignComments: (ownerId, templateId) => listDesignComments(sql, ownerId, templateId),
    createDesignComment: (ownerId, input) => createDesignComment(sql, { id: randomUUID(), ownerId, ...input }),
    setDesignCommentResolved: (ownerId, templateId, id, resolved) => setDesignCommentResolved(sql, ownerId, templateId, id, resolved),
    deleteDesignComment: (ownerId, templateId, id) => deleteDesignComment(sql, ownerId, templateId, id),
    createDesignCommentReply: (ownerId, templateId, commentId, body) =>
      createDesignCommentReply(sql, { id: randomUUID(), ownerId, templateId, commentId, body }),
    buscarCuradoria: (tema, limite) => buscarCuradoriaPorTema(sql, tema, limite),
    listBrandKits: (ownerId) => listBrandKits(sql, ownerId),
    createBrandKit: (ownerId, input) => createBrandKit(sql, { id: randomUUID(), ownerId, ...input }),
    deleteBrandKit: (ownerId, id) => deleteBrandKit(sql, ownerId, id),
  };
} else {
  deps = createLocalDeps(LOCAL_API_KEY!, renderTemplatePng);
}

let media: MediaDeps | null = null;
if (PEXELS_API_KEY || OPENAI_API_KEY) {
  media = {
    service: createMediaAcquisitionService({
      pexelsApiKey: PEXELS_API_KEY,
      openAiApiKey: OPENAI_API_KEY,
      openAiImageModel: OPENAI_IMAGE_MODEL,
    }),
  };
} else if (DATABASE_URL) {
  console.warn("PEXELS_API_KEY/OPENAI_API_KEY not set — automated stock/AI images are disabled");
}

// Auth do console (fase 3 do plano de migração) — só existe quando um projeto Supabase de
// verdade está configurado. Sem isso, /api/v1/auth/* responde 501 e as rotas de template/chave
// continuam funcionando normalmente via chave de API Bearer, como sempre.
let auth: AuthDeps | null = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  auth = {
    client: createSupabaseAuthClient(SUPABASE_URL, SUPABASE_ANON_KEY),
    createDefaultApiKey: (ownerId) => deps.createApiKey(ownerId, "Chave padrão"),
  };
} else if (DATABASE_URL) {
  console.warn("SUPABASE_URL/SUPABASE_ANON_KEY not set — /api/v1/auth/* will respond 501");
}

// Storage (fase 7): bucket público pro PNG renderizado, bucket privado pra foto que o usuário
// sobe. Cliente separado do de Auth de propósito — este usa a chave service-role (ignora RLS),
// nunca deveria ir parar no navegador.
let storage: StorageDeps | null = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  const client = createStorageClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  storage = { client };
  configureStorageClient(client);
  configureFontStorage(client);
} else if (DATABASE_URL) {
  console.warn("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — Storage (uploads, download links) is disabled");
}

// Importar PDF (Conta → Desenvolvedor → Importar): fala com o `pdf-import-service`, um
// microsserviço próprio (Docker separado) que faz a extração de imagem/fonte/texto. Sem a URL
// configurada, a rota responde 501 — não tem pra onde mandar o PDF.
let pdfImport: PdfImportDeps | null = null;
if (PDF_IMPORT_SERVICE_URL) {
  pdfImport = {
    service: createHttpPdfImportService({ serviceUrl: PDF_IMPORT_SERVICE_URL, secret: PDF_IMPORT_SERVICE_SECRET }),
  };
} else if (DATABASE_URL) {
  console.warn("PDF_IMPORT_SERVICE_URL not set — POST /api/v1/imports/pdf will respond 501");
}

const app = buildApp(deps, auth, storage, media, pdfImport);

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`blank-editor render API listening on :${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
