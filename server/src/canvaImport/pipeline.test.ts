import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { cropToBBox, processLayer, processLayerDual, reconstructAlpha, reconstructAlphaExact } from "./pipeline.ts";

/** Dado um alpha e uma cor original "verdadeiros", calcula como aquele pixel apareceria
 *  capturado sobre branco/preto — o inverso exato do que `reconstructAlphaExact` desfaz. */
function compose(alpha: number, [r, g, b]: [number, number, number], bg: 0 | 255): [number, number, number] {
  const mix = (c: number) => Math.round(alpha * c + (1 - alpha) * bg);
  return [mix(r), mix(g), mix(b)];
}

async function solidPng(width: number, height: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();
}

async function readPixel(png: Buffer, x: number, y: number) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

test("reconstructAlpha sobre branco: pixel branco vira transparente, pixel preto vira opaco", async () => {
  const white = await solidPng(2, 2, [255, 255, 255]);
  const black = await solidPng(2, 2, [0, 0, 0]);

  const fromWhite = await readPixel(await reconstructAlpha(white, "white"), 0, 0);
  assert.equal(fromWhite.a, 0);

  const fromBlack = await readPixel(await reconstructAlpha(black, "white"), 0, 0);
  assert.equal(fromBlack.a, 255);
});

test("reconstructAlpha sobre preto: pixel preto vira transparente, pixel branco vira opaco", async () => {
  const white = await solidPng(2, 2, [255, 255, 255]);
  const black = await solidPng(2, 2, [0, 0, 0]);

  const fromBlack = await readPixel(await reconstructAlpha(black, "black"), 0, 0);
  assert.equal(fromBlack.a, 0);

  const fromWhite = await readPixel(await reconstructAlpha(white, "black"), 0, 0);
  assert.equal(fromWhite.a, 255);
});

test("cropToBBox recorta pra caixa do elemento", async () => {
  const canvas = await solidPng(100, 100, [10, 20, 30]);
  const result = await cropToBBox(canvas, { left: 10, top: 10, width: 30, height: 40 }, { width: 100, height: 100 });
  const { info } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 30);
  assert.equal(info.height, 40);
});

test("cropToBBox clampa uma caixa que estoura a borda do canvas", async () => {
  const canvas = await solidPng(100, 100, [10, 20, 30]);
  const result = await cropToBBox(canvas, { left: 90, top: 90, width: 50, height: 50 }, { width: 100, height: 100 });
  const { info } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 10);
  assert.equal(info.height, 10);
});

test("processLayer sem capturedOver só recorta, não mexe em transparência", async () => {
  const canvas = await solidPng(50, 50, [200, 100, 50]);
  const result = await processLayer({
    raw: canvas,
    capturedOver: null,
    bbox: { left: 0, top: 0, width: 20, height: 20 },
    canvas: { width: 50, height: 50 },
  });
  const pixel = await readPixel(result, 0, 0);
  assert.equal(pixel.r, 200);
  assert.equal(pixel.a, 255);
});

test("processLayer com capturedOver reconstrói alpha e recorta numa só chamada", async () => {
  const canvas = await solidPng(50, 50, [255, 255, 255]);
  const result = await processLayer({
    raw: canvas,
    capturedOver: "white",
    bbox: { left: 5, top: 5, width: 10, height: 10 },
    canvas: { width: 50, height: 50 },
  });
  const { info } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 10);
  assert.equal(info.height, 10);
  const pixel = await readPixel(result, 0, 0);
  assert.equal(pixel.a, 0);
});

test("reconstructAlphaExact recupera a cor verdadeira de um pixel semitransparente, não só preto/branco", async () => {
  const trueColor: [number, number, number] = [200, 50, 30];
  const alpha = 0.6;
  const white = await solidPng(2, 2, compose(alpha, trueColor, 255));
  const black = await solidPng(2, 2, compose(alpha, trueColor, 0));

  const pixel = await readPixel(await reconstructAlphaExact(white, black), 0, 0);
  assert.ok(Math.abs(pixel.r - trueColor[0]) <= 1, `r esperado ~${trueColor[0]}, veio ${pixel.r}`);
  assert.ok(Math.abs(pixel.g - trueColor[1]) <= 1, `g esperado ~${trueColor[1]}, veio ${pixel.g}`);
  assert.ok(Math.abs(pixel.b - trueColor[2]) <= 1, `b esperado ~${trueColor[2]}, veio ${pixel.b}`);
  assert.ok(Math.abs(pixel.a - Math.round(alpha * 255)) <= 1);
});

test("reconstructAlphaExact: pixel totalmente opaco preserva a cor original exatamente, ao contrário de reconstructAlpha", async () => {
  const trueColor: [number, number, number] = [10, 20, 30];
  const white = await solidPng(2, 2, trueColor);
  const black = await solidPng(2, 2, trueColor);

  const pixel = await readPixel(await reconstructAlphaExact(white, black), 0, 0);
  assert.deepEqual([pixel.r, pixel.g, pixel.b, pixel.a], [...trueColor, 255]);
});

test("reconstructAlphaExact: pixel totalmente transparente vira alpha 0 independente da cor", async () => {
  const white = await solidPng(2, 2, [255, 255, 255]);
  const black = await solidPng(2, 2, [0, 0, 0]);

  const pixel = await readPixel(await reconstructAlphaExact(white, black), 0, 0);
  assert.equal(pixel.a, 0);
});

test("processLayerDual reconstrói cor exata e recorta numa só chamada", async () => {
  const trueColor: [number, number, number] = [180, 90, 40];
  const alpha = 0.5;
  const white = await solidPng(50, 50, compose(alpha, trueColor, 255));
  const black = await solidPng(50, 50, compose(alpha, trueColor, 0));

  const result = await processLayerDual({
    overWhite: white,
    overBlack: black,
    bbox: { left: 5, top: 5, width: 10, height: 10 },
    canvas: { width: 50, height: 50 },
  });
  const { info } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 10);
  assert.equal(info.height, 10);
  const pixel = await readPixel(result, 0, 0);
  assert.ok(Math.abs(pixel.r - trueColor[0]) <= 1);
});
