import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// This used to build to one self-contained HTML file for publishing as a Claude
// Artifact (vite-plugin-singlefile). The project is now a real hosted app backed
// by server/, so it builds normally instead — real asset splitting/caching is
// what a served app wants, not everything inlined into one file.
const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // Falha em vez de migrar para 5174. Sem isto o Vite muda de porta em
    // silêncio quando a 5173 está ocupada, e você fica olhando uma instância
    // antiga achando que é a nova — o pior tipo de bug de ambiente.
    strictPort: true,
    proxy: {
      // Em container a API é outro serviço ("api"), não localhost. O padrão continua sendo
      // 127.0.0.1 para quem roda `npm run dev` direto no host — o compose injeta a variável.
      "/api": API_PROXY_TARGET,
      "/health": API_PROXY_TARGET,
    },
  },
  build: {
    outDir: "dist",
  },
});
