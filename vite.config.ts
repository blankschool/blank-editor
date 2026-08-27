import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The deliverable is one self-contained HTML file, byte-for-byte publishable as
// an Artifact: no external requests beyond Google Fonts, everything inlined.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    assetsInlineLimit: 100 * 1024 * 1024,
    cssCodeSplit: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 20000,
  },
});
