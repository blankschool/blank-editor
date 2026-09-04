import { existsSync } from "node:fs";
import { buildApp } from "./app.ts";

// Só em dev: em produção (Docker) as env vars vêm injetadas pelo runtime, sem `.env` no disco.
if (existsSync(".env")) process.loadEnvFile(".env");

const port = Number(process.env.PORT) || 8791;
const app = buildApp();

app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
