import { buildApp, type AppDeps } from "./app.ts";
import { createDb, findApiKeyOwner, findTemplate } from "./db.ts";
import { createLocalDeps } from "./local.ts";
import { renderTweetPng } from "./render/renderTweet.ts";

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
    findTemplate: (id, kind) => findTemplate(sql, id, kind),
    renderTweetPng,
  };
} else {
  deps = createLocalDeps(LOCAL_API_KEY!, renderTweetPng);
}

const app = buildApp(deps);

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`blank-editor render API listening on :${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
