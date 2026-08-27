import { buildApp } from "./app.ts";
import { createDb, findApiKeyOwner, findTemplate } from "./db.ts";
import { renderTweetPng } from "./render/renderTweet.ts";

const PORT = Number(process.env.PORT ?? 8787);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = createDb(DATABASE_URL);

const app = buildApp({
  findApiKeyOwner: (keyHash) => findApiKeyOwner(sql, keyHash),
  findTemplate: (id, kind) => findTemplate(sql, id, kind),
  renderTweetPng,
});

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`blank-editor render API listening on :${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
