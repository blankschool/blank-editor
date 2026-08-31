import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { combineWithSoftMask, cropForFrame, flipFromMatrix, parseSvgPageSizePt, parseUseTransforms, placementFromMatrix } from "./pdfSource.ts";

test("parseUseTransforms extrai id e matriz de cada <use>", () => {
  const svg = `<svg><use xlink:href="#source-5" transform="matrix(0.29, 0, 0, 0.29, -40.5, -108.1)"/>
    <use xlink:href="#source-21" filter="url(#x)" transform="matrix(0.325, 0, 0, 0.325, -40.5, -108.1)"/></svg>`;
  const result = parseUseTransforms(svg);
  assert.equal(result.length, 2);
  assert.equal(result[0].sourceId, "source-5");
  assert.equal(result[0].matrix.a, 0.29);
  assert.equal(result[1].sourceId, "source-21");
  assert.equal(result[1].matrix.e, -40.5);
});

test("parseSvgPageSizePt lê width/height em pt do <svg> raiz", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="810pt" height="1079.999946pt" viewBox="0 0 810 1079.999946">`;
  const size = parseSvgPageSizePt(svg);
  assert.equal(size.widthPt, 810);
  assert.ok(Math.abs(size.heightPt - 1080) < 0.01);
});

test("placementFromMatrix converte escala+translação simples pra bbox em px", () => {
  // matrix(a,0,0,d,e,f) sem espelhamento, ptToPx = 4/3 (810pt -> 1080px)
  const bbox = placementFromMatrix({ a: 0.29, b: 0, c: 0, d: 0.29, e: -40.5, f: -108.1 }, 3072, 4096, 4 / 3);
  assert.ok(Math.abs(bbox.left - -54) < 1);
  assert.ok(Math.abs(bbox.top - -144.1) < 1);
  assert.ok(Math.abs(bbox.width - 1187) < 2);
  assert.ok(Math.abs(bbox.height - 1583) < 2);
});

test("flipFromMatrix sinaliza espelhamento pelo sinal de a/d — achado real: a caixa do overlay saía certa mas o conteúdo ficava de cabeça pra baixo até isto ser aplicado", () => {
  assert.deepEqual(flipFromMatrix({ a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 }), { flipY: true, flipX: false });
  assert.deepEqual(flipFromMatrix({ a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 }), { flipY: false, flipX: true });
  assert.deepEqual(flipFromMatrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), { flipY: false, flipX: false });
});

test("placementFromMatrix trata escala negativa (espelhamento) achando o canto certo", () => {
  // d negativo: a imagem é desenhada de baixo pra cima a partir de f — o topo real fica em f + d*height, não em f.
  const bbox = placementFromMatrix({ a: 1, b: 0, c: 0, d: -1, e: 0, f: 100 }, 50, 50, 1);
  assert.equal(bbox.top, 50);
  assert.equal(bbox.height, 50);
});

async function solidPng(width: number, height: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
}

async function grayPng(width: number, height: number, gray: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height, gray);
  return sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

test("combineWithSoftMask junta RGB e máscara num RGBA real", async () => {
  const rgb = await solidPng(4, 4, [200, 50, 30]);
  const mask = await grayPng(4, 4, 128);
  const combined = await combineWithSoftMask(rgb, mask);
  const { data, info } = await sharp(combined).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  assert.equal(data[0], 200);
  assert.equal(data[1], 50);
  assert.equal(data[2], 30);
  assert.equal(data[3], 128);
});

test("combineWithSoftMask rejeita tamanhos diferentes", async () => {
  const rgb = await solidPng(4, 4, [0, 0, 0]);
  const mask = await grayPng(8, 8, 0);
  await assert.rejects(() => combineWithSoftMask(rgb, mask));
});

test("cropForFrame recorta só a região do quadro (0,0..frameSize) dentro da foto-fonte maior", async () => {
  // Foto-fonte 200x200 representando um imageBox de 100x100 (escala 2x, deslocado -25,-25 em
  // relação ao quadro) — o quadro local vai de 0,0 até 50,50, então o recorte deve ser 100x100.
  const source = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  const imageBox = { left: -25, top: -25, width: 100, height: 100 };
  const cropped = await cropForFrame(source, imageBox, { width: 50, height: 50 });
  const meta = await sharp(cropped).metadata();
  assert.equal(meta.width, 100);
  assert.equal(meta.height, 100);
});

test("cropForFrame recorta a caixa certa do badge real testado nesta sessão", async () => {
  const source = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
  const imageBox = { left: -201.40690560574268, top: -145.65608158120182, width: 609.0467040605746, height: 761.3083800757181 };
  const cropped = await cropForFrame(source, imageBox, { width: 334.15934102456845, height: 334.15934102456845 });
  const meta = await sharp(cropped).metadata();
  // Conferido manualmente contra o export real do Canva nesta sessão: ~593x592.
  assert.ok(Math.abs(meta.width! - 593) <= 2, `largura esperada ~593, veio ${meta.width}`);
  assert.ok(Math.abs(meta.height! - 592) <= 2, `altura esperada ~592, veio ${meta.height}`);
});
