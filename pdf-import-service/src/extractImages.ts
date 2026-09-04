/**
 * Extrai as camadas de IMAGEM de uma página de PDF exportado do Canva — recorte, soft-mask e
 * espelhamento corrigidos via a matriz do SVG. Portado de `server/scripts/canva-pdf-extract.ts`
 * do blank-editor principal (mesma lógica, só trocando `execFileSync`/CLI por uma função
 * assíncrona chamável de dentro de uma rota Fastify sem bloquear o event loop).
 *
 * Requer poppler-utils (`pdfimages`, `pdftocairo`) no PATH do container.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { combineWithSoftMask, flipFromMatrix, parseSvgPageSizePt, placementFromMatrix, type Matrix } from "./pdfSource.ts";

const run = promisify(execFile);

export interface ExtractedImageElement {
  type: "image";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  precropped: true;
  contentType: "image/png" | "image/jpeg";
  bytes: Buffer;
}

export interface PageImageResult {
  canvas: { w: number; h: number };
  elements: ExtractedImageElement[];
}

interface ListedImage {
  num: number;
  kind: "image" | "smask" | string;
  width: number;
  height: number;
}

interface Layer {
  rgb: ListedImage;
  mask: ListedImage | null;
}

async function listImages(pdf: string, page: number): Promise<ListedImage[]> {
  const { stdout } = await run("pdfimages", ["-list", "-f", String(page), "-l", String(page), pdf]);
  return stdout
    .split("\n")
    .slice(2)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length > 5 && /^\d+$/.test(cols[1]))
    .map((cols) => ({ num: Number(cols[1]), kind: cols[2], width: Number(cols[3]), height: Number(cols[4]) }));
}

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

async function rawFileFor(dir: string, prefix: string, page: number, num: number): Promise<string> {
  const stem = `${prefix}-${String(page).padStart(3, "0")}-${String(num).padStart(3, "0")}.`;
  const entries = await readdir(dir);
  const found = entries.find((name) => name.startsWith(stem));
  if (!found) throw new Error(`não achei o arquivo extraído de num=${num} (esperava ${stem}*)`);
  return resolve(dir, found);
}

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

/** Ver `matrixByDimensions` original em canva-pdf-extract.ts pra explicação completa das duas
 *  armadilhas (numeração independente SVG/pdfimages, `<use>` apontando pra grupo). */
function matrixByDimensions(svg: string): Map<string, Matrix> {
  const dimsById = new Map<string, string>();
  const imageRe = /<image[^>]*\bid="([^"]+)"[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/g;
  for (let m: RegExpExecArray | null; (m = imageRe.exec(svg)); ) dimsById.set(m[1], `${m[2]}x${m[3]}`);

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
    if (/\/\s*$/.test(attrs)) continue;
    openGroups.push({ id: attrs.match(/\bid="([^"]+)"/)?.[1] ?? null, from: tokenRe.lastIndex });
  }

  const byDims = new Map<string, Matrix>();
  const visit = (fragment: string, inherited: Matrix, depth: number) => {
    if (depth > 8) return;
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

/** Extrai as camadas de imagem de UMA página do PDF, em `workDir` (deve existir e estar vazio
 *  o suficiente pra não colidir com outra página processada em paralelo — o chamador cria um
 *  subdiretório por página). */
export async function extractPageImages(pdfPath: string, page: number, workDir: string, targetWidth = 1080): Promise<PageImageResult> {
  const rawDir = resolve(workDir, "raw");
  await mkdir(rawDir, { recursive: true });

  await run("pdfimages", ["-all", "-p", "-f", String(page), "-l", String(page), pdfPath, resolve(rawDir, "raw")]);
  const svgPath = resolve(rawDir, "page.svg");
  await run("pdftocairo", ["-svg", "-f", String(page), "-l", String(page), pdfPath, svgPath]);

  const svg = await readFile(svgPath, "utf8");
  const { widthPt, heightPt } = parseSvgPageSizePt(svg);
  const ptToPx = targetWidth / widthPt;
  const canvas = { w: Math.round(widthPt * ptToPx), h: Math.round(heightPt * ptToPx) };
  const placements = matrixByDimensions(svg);

  const layers = pairSoftMasks(await listImages(pdfPath, page));
  const elements: ExtractedImageElement[] = [];
  let index = 0;
  for (const layer of layers) {
    const dims = `${layer.rgb.width}x${layer.rgb.height}`;
    const matrix = placements.get(dims);
    if (!matrix) continue; // sem <use> com essas dimensões no SVG — camada pulada

    const rgbFile = await rawFileFor(rawDir, "raw", page, layer.rgb.num);
    const { flipX, flipY } = flipFromMatrix(matrix);

    let bytes: Buffer;
    let contentType: ExtractedImageElement["contentType"];
    if (!layer.mask && !flipX && !flipY) {
      bytes = await readFile(rgbFile);
      contentType = rgbFile.toLowerCase().endsWith(".jpg") || rgbFile.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png";
    } else {
      const composed = layer.mask
        ? await combineWithSoftMask(await readFile(rgbFile), await readFile(await rawFileFor(rawDir, "raw", page, layer.mask.num)))
        : await readFile(rgbFile);
      let pipeline = sharp(composed);
      if (flipY) pipeline = pipeline.flip();
      if (flipX) pipeline = pipeline.flop();
      bytes = await pipeline.png().toBuffer();
      contentType = "image/png";
    }

    const bbox = placementFromMatrix(matrix, layer.rgb.width, layer.rgb.height, ptToPx);
    index += 1;
    elements.push({
      type: "image",
      name: `camada-${index}`,
      x: Math.round(bbox.left * 100) / 100,
      y: Math.round(bbox.top * 100) / 100,
      w: Math.round(bbox.width * 100) / 100,
      h: Math.round(bbox.height * 100) / 100,
      precropped: true,
      contentType,
      bytes,
    });
  }

  return { canvas, elements };
}

/** Conta as páginas do PDF, via `pdfinfo` (mesmo pacote poppler-utils). */
export async function countPdfPages(pdfPath: string): Promise<number> {
  const { stdout } = await run("pdfinfo", [pdfPath]);
  const match = stdout.match(/^Pages:\s*(\d+)/m);
  if (!match) throw new Error("pdfinfo não devolveu a contagem de páginas");
  return Number(match[1]);
}

/** Escreve os bytes de uma camada num arquivo temporário, para debug local — não é chamado no
 *  fluxo normal (a rota manda os bytes direto na resposta), só é útil rodando este módulo à mão. */
export async function debugDump(element: ExtractedImageElement, dir: string): Promise<void> {
  const ext = element.contentType === "image/jpeg" ? "jpg" : "png";
  await writeFile(resolve(dir, `${element.name}.${ext}`), element.bytes);
}
