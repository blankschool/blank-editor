import { renderAsync } from "@resvg/resvg-js";
import { ensureFontFiles, type FaceRef } from "./fontCache.ts";
import { DEFAULT_FONT_FAMILY } from "./editableTweetTemplate.ts";

/**
 * Confere, antes de aceitar tráfego, que o servidor consegue mesmo desenhar texto.
 *
 * Com `loadSystemFonts: false`, um registry vazio não produz erro nenhum: o rasterizador loga um
 * aviso, desenha o vazio e devolve um PNG válido. O deploy sobe verde e a arte sai em branco
 * para o cliente. Este é o único ponto do sistema que transforma isso em ruído.
 *
 * O canário RASTERIZA de verdade em vez de só contar linhas no banco, porque a falha
 * interessante é a que nenhuma query pega: a linha existe, o arquivo existe, e mesmo assim o
 * nome interno da fonte não bate com o que o `font-family` do SVG pede — aí o glifo não sai e
 * nada acusa.
 */

export interface PreflightResult {
  ok: boolean;
  detalhe: string;
}

/** Desenha duas letras e mede se saiu tinta. `Hg` cobre caixa-alta e descendente. */
export async function canarioDeFonte(faces: readonly FaceRef[], family = DEFAULT_FONT_FAMILY): Promise<PreflightResult> {
  if (!faces.length) {
    return { ok: false, detalhe: `nenhuma face registrada para "${family}" — todo texto sairia em branco` };
  }
  let fontFiles: string[];
  try {
    fontFiles = await ensureFontFiles(faces);
  } catch (e) {
    return { ok: false, detalhe: `as faces de "${family}" estão registradas mas não baixam: ${(e as Error).message}` };
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">`
    + `<rect width="300" height="200" fill="#FFFFFF"/>`
    + `<text x="10" y="10" dominant-baseline="text-before-edge" font-family="${family}" font-size="100" fill="#000000">Hg</text></svg>`;
  const png = await renderAsync(svg, { font: { fontFiles, loadSystemFonts: false } });
  const pixels = png.pixels;
  let tinta = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 128) tinta++;

  if (tinta < 50) {
    return {
      ok: false,
      detalhe: `as faces de "${family}" carregaram, mas o rasterizador não desenhou glifo nenhum — ` +
        `o nome interno da fonte provavelmente não bate com o que os documentos pedem em El.font`,
    };
  }
  return { ok: true, detalhe: `"${family}" desenha (${tinta} pixels de tinta no canário)` };
}
