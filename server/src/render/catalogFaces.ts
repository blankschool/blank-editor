import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FaceRef } from "./fontCache.ts";

/**
 * As faces das famílias do catálogo que NÃO vêm do Google Fonts.
 *
 * O painel "Fontes" é servido por folhas do css2, e o render no servidor nunca precisou dessas
 * famílias em disco: quem aplica uma delas num design salva só o nome, e o rasterizador —
 * que roda com `loadSystemFonts: false` (ver fontCache.ts) — resolveria pelo arquivo que o
 * documento declara. Uma família auto-hospedada (src/fontLibrary.ts, campo `files`) não tem
 * nem uma coisa nem outra: sem isto, aplicar Chirp no editor renderizava certo na tela e
 * derrubava a exportação com "não declara nenhuma face para ela em Doc.fonts".
 *
 * Mesma mecânica das embutidas (builtinFaces.ts) e mesma prioridade baixa: documento e
 * registro da conta continuam mandando, isto é só o piso para a família existir.
 *
 * Chirp © X Corp. — fonte proprietária, incluída aqui a pedido do produto.
 */

const aqui = dirname(fileURLToPath(import.meta.url));

function face(family: string, arquivo: string, weight: number): FaceRef {
  const caminho = join(aqui, "fonts", "catalog", arquivo);
  // sha derivado dos bytes, não fixado no código — ver a mesma decisão em builtinFaces.ts.
  const sha256 = createHash("sha256").update(readFileSync(caminho)).digest("hex");
  return { family, weight, sha256, src: caminho };
}

/** Lazy pelo mesmo motivo das embutidas: hashear no import encarece o boot de quem não renderiza. */
let cache: FaceRef[] | null = null;

export function catalogFaces(): FaceRef[] {
  cache ??= [
    face("Chirp", "Chirp-Regular.ttf", 400),
    face("Chirp", "Chirp-Medium.ttf", 500),
    face("Chirp", "Chirp-Bold.ttf", 700),
    face("Chirp", "Chirp-Heavy.ttf", 800),
  ];
  return cache;
}
