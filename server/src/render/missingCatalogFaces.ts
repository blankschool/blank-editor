import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FaceRef } from "./fontCache.ts";
import { fetchGoogleFontFace } from "./googleFontFetch.ts";
import { REPLACEMENT_PREFIX } from "./replacementFonts.ts";

/**
 * As faces que faltam para renderizar, buscadas no Google Fonts na hora.
 *
 * O painel "Fontes" do editor oferece ~57 famílias e carrega todas por folha do css2 — nada
 * disso passa pelo servidor. Um design que usa uma dessas famílias salva só o NOME: não
 * declara face em `Doc.fonts` (isso é coisa de import de PDF) e não está no registry, que é
 * semeado à mão por `scripts/seed-app-fonts.py` com nove famílias. Resultado: aplicar
 * "IBM Plex Mono" desenhava certo na tela e derrubava a exportação com
 *
 *   "o documento usa a família "IBM Plex Mono" mas não declara nenhuma face para ela"
 *
 * Manter a lista do painel espelhada num script de seed é sincronia manual entre dois repos
 * de código que ninguém lembra de fazer (o script ainda cita o `FONTS` de src/editor.ts, que
 * nem existe mais). Buscar sob demanda tira a lista do meio: qualquer família do Google
 * resolve sozinha, e o `fetchGoogleFontFace` já guarda os bytes em disco, então isso é uma
 * requisição por face nova por processo, não por render.
 *
 * Nunca é o caminho principal: só roda para o que documento, registry, embutidas e catálogo
 * local não cobriram. Falha de rede devolve lista vazia e o render volta a parar com a mesma
 * mensagem de antes — buscar fonte não pode virar um jeito novo de um render quebrar.
 */

const cacheDir = join(tmpdir(), "blank-editor-catalog-faces");

/** Famílias que o Google Fonts nunca teria: subset de PDF (`ABCDEF+Nome`) e as de substituição. */
function podeVirDoGoogle(family: string): boolean {
  return !family.startsWith(REPLACEMENT_PREFIX) && !/^[A-Z]{6}\+/.test(family);
}

export async function fetchMissingCatalogFaces(
  wanted: readonly { family: string; weight: number }[],
  jaTemos: readonly FaceRef[],
  deps: { fetchFace?: typeof fetchGoogleFontFace } = {},
): Promise<FaceRef[]> {
  const fetchFace = deps.fetchFace ?? fetchGoogleFontFace;
  // Família inteira, não par família+peso: se a família já tem QUALQUER face, o resolveFaces
  // desenha com ela, e baixar um peso a mais mudaria o desenho de um design que já funciona.
  const familiasCobertas = new Set(jaTemos.map((f) => f.family));
  const faltando = wanted.filter((w) => !familiasCobertas.has(w.family) && podeVirDoGoogle(w.family));
  if (!faltando.length) return [];

  const buscadas = await Promise.all(faltando.map(async ({ family, weight }) => {
    try {
      const face = await fetchFace(family, weight);
      if (!face) return null;
      mkdirSync(cacheDir, { recursive: true });
      // `src` é caminho absoluto local: ensureFontFiles lê do disco, sem rede — igual às
      // embutidas, e é o que faz a segunda renderização não depender mais do Google.
      const caminho = join(cacheDir, `${face.sha256}.ttf`);
      writeFileSync(caminho, face.ttf);
      return { family, weight, sha256: face.sha256, src: caminho } satisfies FaceRef;
    } catch {
      return null;
    }
  }));
  return buscadas.filter((f): f is FaceRef => f !== null);
}
