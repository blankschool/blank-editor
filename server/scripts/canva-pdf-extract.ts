/**
 * Primeira metade do import via PDF: quebra uma página exportada do Canva em camadas de imagem
 * já compostas, posicionadas e prontas pro `canva-import.ts`.
 *
 * `pdfSource.ts` documenta o fluxo e tem a matemática determinística, mas assume que alguém
 * roda `pdfimages`/`pdftocairo` e junta as pontas na mão — este script é essa junção. O que
 * ele NÃO faz é adivinhar nomes: o manifesto sai com `camada-1`, `camada-2`… porque decidir
 * qual imagem é `fundo` e qual é `foto-do-autor` é julgamento de design, e é o nome que vira a
 * superfície da API (`layers: { fundo: ... }`). Texto e formas também ficam de fora — no PDF
 * eles já são vetor, então recriá-los como `text`/`rect` de verdade no manifesto é o que os
 * mantém editáveis; rasterizá-los aqui destruiria exatamente o que se quer preservar.
 *
 * Uso: node scripts/canva-pdf-extract.ts <arquivo.pdf> <pasta-de-saida> [--page N] [--width PX]
 * Requer poppler-utils (`pdfimages`, `pdftocairo`) no PATH.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import {
  combineWithSoftMask,
  flipFromMatrix,
  parseSvgPageSizePt,
  parseUseTransforms,
  placementFromMatrix,
  type Matrix,
} from "../src/canvaImport/pdfSource.ts";

interface ListedImage {
  num: number;
  kind: "image" | "smask" | string;
  width: number;
  height: number;
}

/** Uma camada final: RGB sozinho, ou RGB + soft-mask que viram um RGBA de verdade. */
interface Layer {
  rgb: ListedImage;
  mask: ListedImage | null;
}

/** Lê a tabela do `pdfimages -list`. Só as quatro colunas que importam aqui — as outras
 *  (ppi, tamanho, razão de compressão) são diagnóstico humano, não entram na decisão. */
function listImages(pdf: string, page: number): ListedImage[] {
  const out = execFileSync("pdfimages", ["-list", "-f", String(page), "-l", String(page), pdf], { encoding: "utf8" });
  return out
    .split("\n")
    .slice(2)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length > 5 && /^\d+$/.test(cols[1]))
    .map((cols) => ({ num: Number(cols[1]), kind: cols[2], width: Number(cols[3]), height: Number(cols[4]) }));
}

/** Uma soft-mask sempre vem logo depois do RGB que ela recorta, e com as mesmas dimensões —
 *  é como o PDF grava o par. Emparelhar por adjacência+dimensão evita ter que abrir o objeto
 *  do PDF só pra ler `/SMask`. */
function pairSoftMasks(images: ListedImage[]): Layer[] {
  const layers: Layer[] = [];
  for (let i = 0; i < images.length; i++) {
    const current = images[i];
    if (current.kind === "smask") continue;
    const next = images[i + 1];
    const paired = next && next.kind === "smask" && next.width === current.width && next.height === current.height;
    layers.push({ rgb: current, mask: paired ? next : null });
  }
  return layers;
}

/** `pdfimages -all` nomeia por `<prefixo>-<pagina>-<num>.<ext>`, com a extensão variando com o
 *  encoding original (jpeg sai .jpg, o resto .png) — daí procurar pelo prefixo em vez de montar
 *  o nome. */
function rawFileFor(dir: string, prefix: string, page: number, num: number): string {
  const stem = `${prefix}-${String(page).padStart(3, "0")}-${String(num).padStart(3, "0")}.`;
  const found = readdirSync(dir).find((name) => name.startsWith(stem));
  if (!found) throw new Error(`não achei o arquivo extraído de num=${num} (esperava ${stem}*)`);
  return resolve(dir, found);
}

/** Composição de duas matrizes SVG: o ponto passa primeiro pela de dentro, depois pela de fora. */
function compose(outer: Matrix, inner: Matrix): Matrix {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function parseTransform(value: string | undefined): Matrix {
  if (!value) return IDENTITY;
  const matrix = value.match(/matrix\(([^)]+)\)/);
  if (matrix) {
    const [a, b, c, d, e, f] = matrix[1].split(",").map((n) => parseFloat(n.trim()));
    return { a, b, c, d, e, f };
  }
  const translate = value.match(/translate\(([^)]+)\)/);
  if (translate) {
    const [e, f] = translate[1].split(/[,\s]+/).map((n) => parseFloat(n.trim()));
    return { ...IDENTITY, e, f: f || 0 };
  }
  return IDENTITY;
}

/**
 * Casa cada camada com a posição dela na página, por dimensão.
 *
 * Duas armadilhas, as duas descobertas com a caixa saindo no lugar errado:
 *
 *  1. O `<image id="source-N">` do SVG e a linha do `pdfimages` são a mesma imagem embutida,
 *     mas os numeradores são independentes (um conta objetos do SVG, o outro imagens por
 *     página) — não dá pra assumir `source-N` ↔ `num=N`. Largura×altura nativas, essas sim,
 *     são as mesmas dos dois lados, e é por elas que se casa.
 *  2. Um `<use>` nem sempre aponta direto pra imagem. Quando o Canva recorta a foto (uma foto
 *     dentro de um círculo, por exemplo), o pdftocairo embrulha tudo num `<g id="source-N">`
 *     nos defs e o corpo referencia esse GRUPO — a matriz de dentro é relativa ao grupo, não
 *     à página. Sem compor as duas, a foto recortada aterrissa a centenas de pixels do lugar.
 *
 * Conteúdo de `<mask>` fica de fora de propósito: ali o mesmo `source-N` aparece de novo só
 * como passe de alfa, e a máscara já entra na camada por `combineWithSoftMask`.
 */
function matrixByDimensions(svg: string): Map<string, Matrix> {
  const dimsById = new Map<string, string>();
  const imageRe = /<image[^>]*\bid="([^"]+)"[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/g;
  for (let m: RegExpExecArray | null; (m = imageRe.exec(svg)); ) dimsById.set(m[1], `${m[2]}x${m[3]}`);

  // Corpo de cada `<g id="...">` dos defs, para resolver um `<use>` que aponte pro grupo.
  const groups = new Map<string, string>();
  const tokenRe = /<(\/?)(g|mask|use)\b([^>]*)>/g;
  const openGroups: Array<{ id: string | null; from: number }> = [];
  for (let m: RegExpExecArray | null; (m = tokenRe.exec(svg)); ) {
    const [, closing, tag, attrs] = m;
    if (tag !== "g") continue;
    if (closing) {
      const opened = openGroups.pop();
      if (opened?.id) groups.set(opened.id, svg.slice(opened.from, m.index));
      continue;
    }
    if (/\/\s*$/.test(attrs)) continue; // <g .../> vazio
    openGroups.push({ id: attrs.match(/\bid="([^"]+)"/)?.[1] ?? null, from: tokenRe.lastIndex });
  }

  const byDims = new Map<string, Matrix>();
  const visit = (fragment: string, inherited: Matrix, depth: number) => {
    if (depth > 8) return; // defs cíclico não deveria existir, mas não vale travar por causa disso
    const stack: Matrix[] = [inherited];
    const walkRe = /<(\/?)(g|mask|use)\b([^>]*)>/g;
    let maskDepth = 0;
    for (let m: RegExpExecArray | null; (m = walkRe.exec(fragment)); ) {
      const [, closing, tag, attrs] = m;
      if (tag === "mask") { maskDepth += closing ? -1 : 1; continue; }
      if (maskDepth > 0) continue;
      if (tag === "g") {
        if (closing) stack.pop();
        else if (!/\/\s*$/.test(attrs)) {
          stack.push(compose(stack[stack.length - 1], parseTransform(attrs.match(/\btransform="([^"]+)"/)?.[1])));
        }
        continue;
      }
      const href = attrs.match(/xlink:href="#([^"]+)"/)?.[1];
      if (!href) continue;
      const here = compose(stack[stack.length - 1], parseTransform(attrs.match(/\btransform="([^"]+)"/)?.[1]));
      const dims = dimsById.get(href);
      if (dims) { if (!byDims.has(dims)) byDims.set(dims, here); continue; }
      const group = groups.get(href);
      if (group) visit(group, here, depth + 1);
    }
  };
  visit(svg.slice(svg.lastIndexOf("</defs>") + 1), IDENTITY, 0);
  return byDims;
}

async function main() {
  const [pdfArg, outArg, ...rest] = process.argv.slice(2);
  if (!pdfArg || !outArg) {
    console.error("uso: node scripts/canva-pdf-extract.ts <arquivo.pdf> <pasta-de-saida> [--page N] [--width PX]");
    process.exit(1);
  }
  const page = Number(rest[rest.indexOf("--page") + 1]) || 1;
  const targetWidth = rest.includes("--width") ? Number(rest[rest.indexOf("--width") + 1]) : 1080;

  const pdf = resolve(pdfArg);
  const outDir = resolve(outArg);
  const rawDir = resolve(outDir, "raw");
  mkdirSync(rawDir, { recursive: true });

  execFileSync("pdfimages", ["-all", "-p", "-f", String(page), "-l", String(page), pdf, resolve(rawDir, "raw")]);
  const svgPath = resolve(rawDir, "page.svg");
  execFileSync("pdftocairo", ["-svg", "-f", String(page), "-l", String(page), pdf, svgPath]);

  const svg = readFileSync(svgPath, "utf8");
  const { widthPt, heightPt } = parseSvgPageSizePt(svg);
  const ptToPx = targetWidth / widthPt;
  const canvas = { w: Math.round(widthPt * ptToPx), h: Math.round(heightPt * ptToPx) };
  const placements = matrixByDimensions(svg);

  const layers = pairSoftMasks(listImages(pdf, page));
  const elements = [];
  for (const [index, layer] of layers.entries()) {
    const dims = `${layer.rgb.width}x${layer.rgb.height}`;
    const matrix = placements.get(dims);
    if (!matrix) {
      console.warn(`camada ${index + 1} (${dims}): nenhum <use> com essas dimensões no SVG — pulada`);
      continue;
    }

    const rgbFile = rawFileFor(rawDir, "raw", page, layer.rgb.num);
    const { flipX, flipY } = flipFromMatrix(matrix);

    // Sem máscara e sem espelhamento não há o que compor: copiar o arquivo do jeito que saiu do
    // PDF é de graça e sem perda. Reencodar tudo pra PNG "por uniformidade" inflava uma foto de
    // fundo JPEG de 900KB pra 5MB — e é um arquivo que todo render vai baixar de novo.
    let buffer: Buffer;
    let extension: string;
    if (!layer.mask && !flipX && !flipY) {
      buffer = readFileSync(rgbFile);
      extension = rgbFile.slice(rgbFile.lastIndexOf(".") + 1);
    } else {
      const composed = layer.mask
        ? await combineWithSoftMask(readFileSync(rgbFile), readFileSync(rawFileFor(rawDir, "raw", page, layer.mask.num)))
        : readFileSync(rgbFile);
      // A matriz espelhada só acerta a CAIXA sozinha; os pixels continuam como estavam no
      // arquivo — sem isto a camada fica no lugar certo de cabeça pra baixo (pdfSource.ts).
      let pipeline = sharp(composed);
      if (flipY) pipeline = pipeline.flip();
      if (flipX) pipeline = pipeline.flop();
      buffer = await pipeline.png().toBuffer();
      extension = "png";
    }

    const bbox = placementFromMatrix(matrix, layer.rgb.width, layer.rgb.height, ptToPx);
    const rawFile = `camada-${index + 1}.${extension}`;
    writeFileSync(resolve(outDir, rawFile), buffer);
    elements.push({
      type: "image",
      name: `camada-${index + 1}`,
      x: Math.round(bbox.left * 100) / 100,
      y: Math.round(bbox.top * 100) / 100,
      w: Math.round(bbox.width * 100) / 100,
      h: Math.round(bbox.height * 100) / 100,
      precropped: true,
      rawFile,
    });
    console.log(`camada-${index + 1}: ${dims}${layer.mask ? " + máscara" : ""} → ${rawFile}`);
  }

  const manifest = {
    templateName: "Design importado do Canva",
    pages: [{ w: canvas.w, h: canvas.h, bg: "#000000", elements }],
  };
  writeFileSync(resolve(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\npágina ${canvas.w}×${canvas.h}px — rascunho em ${resolve(outDir, "manifest.json")}`);
  console.log("nomeie as camadas, recrie texto/formas como elementos de verdade, depois:");
  console.log(`  node scripts/canva-import.ts ${resolve(outDir, "manifest.json")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
