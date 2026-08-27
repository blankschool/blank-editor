import { randomUUID } from "node:crypto";
import { buildApp, type AppDeps } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import {
  createDb,
  createApiKey,
  createTemplate,
  deleteApiKey,
  deleteTemplate,
  findApiKeyOwner,
  findTemplate,
  listApiKeys,
  listTemplates,
  revokeApiKey,
  updateTemplate,
} from "./db.ts";
import { createLocalDeps } from "./local.ts";
import { renderTemplatePng } from "./render/renderTweet.ts";

const PORT = Number(process.env.PORT ?? 8787);
const DATABASE_URL = process.env.DATABASE_URL;
const LOCAL_API_KEY = process.env.LOCAL_API_KEY;

if (!DATABASE_URL && !LOCAL_API_KEY) {
  console.error("DATABASE_URL is required in production; use LOCAL_API_KEY for local development");
  process.exit(1);
}

let deps: AppDeps;
if (DATABASE_URL) {
  const sql = createDb(DATABASE_URL);
  deps = {
    findApiKeyOwner: (keyHash) => findApiKeyOwner(sql, keyHash),
    findTemplate: (id) => findTemplate(sql, id),
    listTemplates: () => listTemplates(sql),
    createTemplate: ({ name, document }) => createTemplate(sql, { id: randomUUID(), kind: "custom", name, document }),
    updateTemplate: (id, input) => updateTemplate(sql, id, input),
    deleteTemplate: (id) => deleteTemplate(sql, id),
    listApiKeys: () => listApiKeys(sql),
    createApiKey: async (name) => {
      const secret = `blk_live_${randomUUID().replace(/-/g, "")}`;
      const created = await createApiKey(sql, { id: randomUUID(), name, keyHash: hashApiKey(secret) });
      return { ...created, secret };
    },
    revokeApiKey: (id) => revokeApiKey(sql, id),
    deleteApiKey: (id) => deleteApiKey(sql, id),
    renderTemplatePng,
  };
} else {
  deps = createLocalDeps(LOCAL_API_KEY!, renderTemplatePng);
}

const app = buildApp(deps);

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`blank-editor render API listening on :${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
