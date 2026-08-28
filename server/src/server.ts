import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildApp, type AppDeps, type AuthDeps, type StorageDeps } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import { createSupabaseAuthClient } from "./supabaseAuth.ts";
import { createStorageClient } from "./storage.ts";
import {
  createDb,
  createApiKey,
  createTemplate,
  createWorkspace,
  deleteApiKey,
  deleteTemplate,
  findApiKeyOwner,
  findTemplate,
  findWorkspaceByEmail,
  listApiKeys,
  listTemplates,
  revokeApiKey,
  updateTemplate,
} from "./db.ts";
import { createLocalDeps } from "./local.ts";
import { configureStorageClient, renderTemplatePng } from "./render/renderTweet.ts";

// Só em dev: `.env` não existe em produção (env vars vêm injetadas pelo runtime lá), e não faz
// sentido nenhum exigir esse arquivo pra rodar o servidor de verdade — daí o existsSync antes.
if (existsSync(".env")) process.loadEnvFile(".env");

const PORT = Number(process.env.PORT ?? 8787);
const DATABASE_URL = process.env.DATABASE_URL;
const LOCAL_API_KEY = process.env.LOCAL_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!DATABASE_URL && !LOCAL_API_KEY) {
  console.error("DATABASE_URL is required in production; use LOCAL_API_KEY for local development");
  process.exit(1);
}

let deps: AppDeps;
if (DATABASE_URL) {
  const sql = createDb(DATABASE_URL);
  deps = {
    findApiKeyOwner: (keyHash) => findApiKeyOwner(sql, keyHash),
    findTemplate: (ownerId, id) => findTemplate(sql, ownerId, id),
    listTemplates: (ownerId) => listTemplates(sql, ownerId),
    createTemplate: (ownerId, { name, document }) =>
      createTemplate(sql, { id: randomUUID(), ownerId, kind: "custom", name, document }),
    updateTemplate: (ownerId, id, input) => updateTemplate(sql, ownerId, id, input),
    deleteTemplate: (ownerId, id) => deleteTemplate(sql, ownerId, id),
    listApiKeys: (ownerId) => listApiKeys(sql, ownerId),
    createApiKey: async (ownerId, name) => {
      const secret = `blk_live_${randomUUID().replace(/-/g, "")}`;
      const created = await createApiKey(sql, { id: randomUUID(), ownerId, name, keyHash: hashApiKey(secret) });
      return { ...created, secret };
    },
    revokeApiKey: (ownerId, id) => revokeApiKey(sql, ownerId, id),
    deleteApiKey: (ownerId, id) => deleteApiKey(sql, ownerId, id),
    findWorkspaceByEmail: (email) => findWorkspaceByEmail(sql, email),
    createWorkspace: ({ name, email }) => createWorkspace(sql, { id: randomUUID(), name, email }),
    renderTemplatePng,
  };
} else {
  deps = createLocalDeps(LOCAL_API_KEY!, renderTemplatePng);
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
} else if (DATABASE_URL) {
  console.warn("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — Storage (uploads, download links) is disabled");
}

const app = buildApp(deps, auth, storage);

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`blank-editor render API listening on :${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
