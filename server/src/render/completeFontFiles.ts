import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replacementFontFiles } from "./replacementFonts.ts";
import type { FaceRef } from "./fontCache.ts";

let cached: FaceRef[] | undefined;
export function completeFontPath(file: string): string | null {
  if (!replacementFontFiles.some(f => f.file === file)) return null;
  return fileURLToPath(new URL(`./fonts/complete/${file}`, import.meta.url));
}
export function completeFontFaces(): FaceRef[] {
  return cached ??= replacementFontFiles.map(f => {
    const src = completeFontPath(f.file)!;
    return { family: f.family, weight: f.weight, style: f.style, src,
      sha256: createHash("sha256").update(readFileSync(src)).digest("hex") };
  });
}
