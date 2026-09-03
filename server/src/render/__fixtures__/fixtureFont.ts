import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fonte de teste, gerada sinteticamente (cada glifo é um retângulo de meia em).
 *
 * Sintética por três razões: não envolve licença de terceiro; as métricas são escolhidas e não
 * medidas, então um teste pode afirmar largura exata (0.5 em por glifo); e ela existe em disco,
 * o que exercita o mesmo caminho de cache que a produção usa — `FaceRef.src` aceita caminho
 * absoluto justamente para isto.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_FONT_PATH = resolve(here, "BlankFixture-Regular.ttf");
export const FIXTURE_FAMILY = "BlankFixture";
export const FIXTURE_SHA256 = createHash("sha256").update(readFileSync(FIXTURE_FONT_PATH)).digest("hex");
/** Avanço de cada glifo, em frações do corpo — o retângulo tem 500/1000 unidades. */
export const FIXTURE_ADVANCE_EM = 0.5;

/** Entrada pronta para `Doc.fonts`. */
export function fixtureDocFont(weight = 400) {
  return { family: FIXTURE_FAMILY, weight, sha256: FIXTURE_SHA256, ttf: FIXTURE_FONT_PATH, woff2: "" };
}
