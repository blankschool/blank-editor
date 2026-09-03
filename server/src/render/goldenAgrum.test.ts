import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { renderTemplatePng } from "./renderTweet.ts";

/**
 * Regressão do design real, contra o PDF de onde ele saiu.
 *
 * Este é o teste que a migração de rasterizador precisava e não existia: os testes de render
 * só olhavam `metadata()` — formato e dimensões —, então o texto podia sair na fonte errada, no
 * lugar errado, ou não sair, e tudo continuava verde. Foi assim que a manchete sobreposta
 * chegou até o usuário.
 *
 * Compara caixa de tinta por cor, não bytes: JPEG e antialiasing mudam pixels sem mudar o
 * desenho. O que se afirma é onde cada bloco de texto começa e quanto ele ocupa — exatamente o
 * que quebra quando a fonte é substituída.
 */

const dir = resolve(import.meta.dirname, "../../../imports/agrum-barretos");
const referencia = "/tmp/ref.png";

function montaDocumento() {
  const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8"));
  const faces = JSON.parse(readFileSync(resolve(dir, "fonts/fonts.json"), "utf8"));
  const page = manifest.pages[0];
  const els = page.elements.map((el: Record<string, unknown>) => {
    const { rawFile, precropped, ...rest } = el as { rawFile?: string; precropped?: boolean };
    const base = { id: randomUUID(), rot: 0, opacity: 1, locked: false, hidden: false,
                   fill: "", stroke: "", strokeWidth: 0, radius: 0, ...rest };
    if (!rawFile) return base;
    const mime = /\.jpe?g$/i.test(rawFile) ? "image/jpeg" : "image/png";
    return { ...base, src: `data:${mime};base64,${readFileSync(resolve(dir, rawFile)).toString("base64")}` };
  });
  return {
    name: manifest.templateName, active: 0,
    fonts: faces.map((f: { familia: string; peso: number; sha256: string; arquivo: string }) => ({
      family: f.familia, weight: f.peso, sha256: f.sha256,
      ttf: resolve(dir, "fonts", `${f.arquivo}.ttf`), woff2: "",
    })),
    pages: [{ id: randomUUID(), w: page.w, h: page.h, bg: page.bg, els }],
  };
}

async function caixaDeTinta(file: string | Buffer, region: { left: number; top: number; width: number; height: number },
                            aceita: (r: number, g: number, b: number) => boolean) {
  const { data, info } = await sharp(file).removeAlpha().extract(region).raw().toBuffer({ resolveWithObject: true });
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let i = 0, p = 0; i < data.length; i += info.channels, p++) {
    if (!aceita(data[i], data[i + 1], data[i + 2])) continue;
    const x = p % info.width, y = (p / info.width) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: region.left + x0, y: region.top + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const verde = (r: number, g: number, b: number) => r < 130 && g > 175 && b > 80 && b < 175;
const branco = (r: number, g: number, b: number) => r > 225 && g > 225 && b > 225;
const escuro = (r: number, g: number, b: number) => r < 60 && g < 70 && b < 60;

const SONDAS: Array<[string, { left: number; top: number; width: number; height: number }, (r: number, g: number, b: number) => boolean]> = [
  ["'Barretos' em verde",      { left: 90,  top: 1070, width: 340, height: 95 },  verde],
  ["'R$600 milhões' em verde", { left: 190, top: 1230, width: 620, height: 100 }, verde],
  ["'NEGÓCIOS' no selo",       { left: 112, top: 995,  width: 240, height: 50 },  escuro],
  ["'AGRUM JORNAL'",           { left: 90,  top: 110,  width: 620, height: 110 }, branco],
];

// A referência é o PDF original rasterizado a 1080x1440 (pdftoppm -scale-to-x 1080). Não fica
// versionada: são 1.6MB de foto de terceiro. Sem ela o teste se declara pulado, alto, em vez de
// passar vazio fingindo que verificou algo.
test("o design importado renderiza igual ao PDF de origem, dentro de 2px", { skip: !existsSync(referencia) && `referência ausente (${referencia})` }, async () => {
  const png = await renderTemplatePng(montaDocumento(), { texts: {}, images: {}, hidden: new Set() });
  for (const [rotulo, region, aceita] of SONDAS) {
    const [esperado, obtido] = await Promise.all([caixaDeTinta(referencia, region, aceita), caixaDeTinta(png, region, aceita)]);
    assert.ok(esperado, `${rotulo}: a referência não tem tinta nessa região`);
    assert.ok(obtido, `${rotulo}: o render não desenhou nada — fonte não carregada?`);
    for (const eixo of ["x", "y", "w", "h"] as const) {
      const desvio = Math.abs(obtido[eixo] - esperado[eixo]);
      assert.ok(desvio <= 2, `${rotulo}: ${eixo} desviou ${desvio}px (esperado ${esperado[eixo]}, obtido ${obtido[eixo]})`);
    }
  }
});
