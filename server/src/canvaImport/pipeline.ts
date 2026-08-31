import sharp from "sharp";

/** Cor sólida conhecida sobre a qual uma camada isolada foi exportada (opacidade de todo o
 *  resto zerada no Canva) — é o que permite recuperar um alpha de verdade, já que a exportação
 *  do Canva nunca traz transparência real. */
export type CapturedOver = "white" | "black";

export interface Bbox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

/** Recupera um canal alfa real a partir de um render capturado sobre fundo sólido, por
 *  luminância: sobre branco, quanto mais escuro o pixel mais opaco era o original (e vice-versa
 *  sobre preto). É uma aproximação — a cor original de cada pixel é sempre assumida preta
 *  (captura sobre branco) ou branca (captura sobre preto), nunca recuperada de verdade —, mas é
 *  suficiente pra sombras/overlays translúcidos, que é o caso que motivou isto. */
export async function reconstructAlpha(inputBuffer: Buffer, capturedOver: CapturedOver): Promise<Buffer> {
  const img = sharp(inputBuffer).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(data.length);
  const isWhite = capturedOver === "white";
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
    const alpha = isWhite ? 255 - lum : lum;
    const color = isWhite ? 0 : 255;
    out[i] = color;
    out[i + 1] = color;
    out[i + 2] = color;
    out[i + 3] = alpha;
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** Recupera alpha E cor originais de verdade, a partir de DUAS capturas do mesmo elemento
 *  isolado — uma sobre branco, outra sobre preto (mesma posição/conteúdo, só o fundo muda).
 *  `reconstructAlpha()` (uma captura só) tem que *assumir* a cor original de cada pixel (preto
 *  ou branco) — exato pra conteúdo já mono (o "Lord" branco do primeiro teste), mas destrói a
 *  cor de qualquer foto real (foi o caso dos emblemas do segundo teste — saíam acinzentados).
 *  Com duas capturas dá pra resolver as duas incógnitas (alpha e cor) por triangulação: como
 *  `over_white - over_black = (1-alpha) * (branco - preto)` em cada canal, alpha sai direto da
 *  diferença entre as duas capturas, e a cor original sai revertendo a composição sobre
 *  qualquer uma delas. Custa uma exportação a mais por camada; mais correto que assumir. */
export async function reconstructAlphaExact(overWhite: Buffer, overBlack: Buffer): Promise<Buffer> {
  const [white, black] = await Promise.all([
    sharp(overWhite).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(overBlack).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (white.info.width !== black.info.width || white.info.height !== black.info.height) {
    throw new Error("reconstructAlphaExact: as duas capturas têm tamanhos diferentes");
  }
  const w = white.data;
  const b = black.data;
  const out = Buffer.alloc(w.length);
  for (let i = 0; i < w.length; i += 4) {
    const diffR = w[i] - b[i];
    const diffG = w[i + 1] - b[i + 1];
    const diffB = w[i + 2] - b[i + 2];
    const alpha = Math.max(0, Math.min(255, 255 - (diffR + diffG + diffB) / 3));
    if (alpha < 1) {
      out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
      continue;
    }
    const a = alpha / 255;
    // over_white = a*F + (1-a)*255  =>  F = (over_white - (1-a)*255) / a
    const unmix = (whiteChannel: number) => Math.max(0, Math.min(255, Math.round((whiteChannel - (1 - a) * 255) / a)));
    out[i] = unmix(w[i]);
    out[i + 1] = unmix(w[i + 1]);
    out[i + 2] = unmix(w[i + 2]);
    out[i + 3] = alpha;
  }
  return sharp(out, { raw: { width: white.info.width, height: white.info.height, channels: 4 } }).png().toBuffer();
}

/** Recorta o render (do tamanho da página inteira) pra caixa própria do elemento, clampada ao
 *  canvas visível — a parte de uma caixa autorada que estoura a borda da página já era invisível
 *  no Canva, então clampar não perde nada real. */
export async function cropToBBox(fullCanvasBuffer: Buffer, bbox: Bbox, canvas: CanvasSize): Promise<Buffer> {
  const x0 = Math.max(0, bbox.left);
  const y0 = Math.max(0, bbox.top);
  const x1 = Math.min(canvas.width, bbox.left + bbox.width);
  const y1 = Math.min(canvas.height, bbox.top + bbox.height);
  const width = Math.round(x1 - x0);
  const height = Math.round(y1 - y0);
  return sharp(fullCanvasBuffer)
    .extract({ left: Math.round(x0), top: Math.round(y0), width, height })
    .png()
    .toBuffer();
}

export interface ProcessLayerInput {
  /** PNG do elemento isolado (opacidade de tudo mais zerada), exportado em página inteira. */
  raw: Buffer;
  /** `null` pra camadas sem transparência a recuperar — uma foto comum, por exemplo. */
  capturedOver: CapturedOver | null;
  bbox: Bbox;
  canvas: CanvasSize;
}

/** Pipeline completo de uma camada de imagem: reconstrói o alpha (se aplicável) e recorta pra
 *  caixa do elemento. Devolve o PNG pronto pra upload — nunca base64 embutido em JSON, que é
 *  o que fazia o protótipo em `/Users/it4mi/Downloads/teste/_pipeline` inflar templates de poucas
 *  páginas pra alguns megabytes. */
export async function processLayer({ raw, capturedOver, bbox, canvas }: ProcessLayerInput): Promise<Buffer> {
  const withAlpha = capturedOver ? await reconstructAlpha(raw, capturedOver) : raw;
  return cropToBBox(withAlpha, bbox, canvas);
}

export interface ProcessLayerDualInput {
  /** PNG do elemento isolado, exportado em página inteira, sobre fundo branco. */
  overWhite: Buffer;
  /** A mesma isolação, exportada de novo sobre fundo preto. */
  overBlack: Buffer;
  bbox: Bbox;
  canvas: CanvasSize;
}

/** Mesmo pipeline de `processLayer`, mas com cor exata (`reconstructAlphaExact`) em vez de
 *  assumida — usar quando a camada é uma foto de verdade, não um logo/texto de cor única. */
export async function processLayerDual({ overWhite, overBlack, bbox, canvas }: ProcessLayerDualInput): Promise<Buffer> {
  const withAlpha = await reconstructAlphaExact(overWhite, overBlack);
  return cropToBBox(withAlpha, bbox, canvas);
}
