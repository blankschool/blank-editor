import { defineConfig } from "vite";

// This used to build to one self-contained HTML file for publishing as a Claude
// Artifact (vite-plugin-singlefile). The project is now a real hosted app backed
// by server/, so it builds normally instead — real asset splitting/caching is
// what a served app wants, not everything inlined into one file.
export default defineConfig({
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/health": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: "dist",
  },
});
