import sharp from "sharp";
import type { Bbox } from "./pipeline.ts";

/**
 * Alternativa à isolação por opacidade (`pipeline.ts`): a exportação em PDF do Canva embute
 * cada imagem separadamente — com canal alfa real via soft-mask, sem achatar nada — e o texto
 * como texto vetorial de verdade. Descoberto ao investigar como o Templated.io importa do
 * Canva; confirmado testando neste projeto (ver a seção "Reconstrução via PDF" do plano).
 *
 * O fluxo real (fora deste arquivo, cada passo é uma ferramenta de sistema já disponível):
 * 1. `export-design` (MCP) com `format:{type:"pdf"}` — uma chamada só por página.
 * 2. `pdfimages -list`/`-png -all <pdf> <prefixo>` (poppler-utils) — extrai cada imagem
 *    embutida como arquivo separado; uma imagem com transparência sai como um par
 *    RGB (`type: image`) + máscara em cinza (`type: smask`), sempre adjacentes na listagem.
 * 3. `pdftocairo -svg <pdf> <saida>` (poppler-utils) — dá a posição/escala de cada imagem
 *    na página via `<use xlink:href="#source-N" transform="matrix(a,0,0,d,e,f)"/>`.
 *
 * Este arquivo cuida só da matemática determinística de juntar isso — decidir qual imagem do
 * PDF corresponde a qual elemento do `design_content` (lido via `read-design`) continua sendo
 * julgamento por design, feito ao montar o manifesto.
 */

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** Extrai todo `<use xlink:href="#ID" ... transform="matrix(...)">` do SVG gerado por
 *  `pdftocairo -svg`. Cada `<image id="source-N">` só define os pixels; é o `<use>` que diz
 *  onde na página aquilo aparece — um mesmo `source-N` pode ter mais de um `<use>` (ex.: base
 *  color + passe de máscara do mesmo par com soft-mask, ou uma imagem duplicada no design). */
export function parseUseTransforms(svg: string): Array<{ sourceId: string; matrix: Matrix }> {
  const results: Array<{ sourceId: string; matrix: Matrix }> = [];
  const re = /<use\s+xlink:href="#([^"]+)"[^>]*?transform="matrix\(([^)]+)\)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const [a, b, c, d, e, f] = m[2].split(",").map((n) => parseFloat(n.trim()));
    results.push({ sourceId: m[1], matrix: { a, b, c, d, e, f } });
  }
  return results;
}

/** Lê `width="810pt" height="1080pt"` (ou similar) do elemento raiz do SVG. */
export function parseSvgPageSizePt(svg: string): { widthPt: number; heightPt: number } {
  const m = svg.match(/<svg[^>]*width="([\d.]+)pt"[^>]*height="([\d.]+)pt"/);
  if (!m) throw new Error("parseSvgPageSizePt: não achei width/height em pt no <svg> raiz");
  return { widthPt: parseFloat(m[1]), heightPt: parseFloat(m[2]) };
}

/** `a`/`d` negativos na matriz não são só "a caixa fica em outro canto" — o PDF está pedindo
 *  pra desenhar a imagem espelhada naquele eixo. `placementFromMatrix` já acerta a caixa
 *  sozinha (via min/max), mas os PIXELS continuam do jeito que estavam no arquivo original —
 *  quem usa isto tem que espelhar o buffer de verdade (`sharp(buf).flip()`/`.flop()`) antes de
 *  salvar/compor, senão a imagem fica no lugar certo com o conteúdo de cabeça pra baixo (foi
 *  exatamente o bug do overlay/vinheta neste projeto: a caixa saiu certa, o gradiente saiu
 *  invertido — escuro em cima da página em vez de embaixo). */
export function flipFromMatrix(matrix: Matrix): { flipY: boolean; flipX: boolean } {
  return { flipY: matrix.d < 0, flipX: matrix.a < 0 };
}

/** Converte uma matriz de posicionamento (escala + translação, sem rotação — cobre 0°/180°,
 *  a mesma limitação já aceita no resto deste pipeline) na caixa final em pixels de página.
 *  `a`/`d` negativos (espelhamento) são tratados corretamente pra caixa (ver `flipFromMatrix`
 *  pra também corrigir o conteúdo): o canto "final" pode ficar antes do "inicial" nos eixos
 *  espelhados, por isso usa-se min/max em vez de assumir `e,f` como canto superior-esquerdo. */
export function placementFromMatrix(matrix: Matrix, imgWidthPx: number, imgHeightPx: number, ptToPx: number): Bbox {
  const { a, d, e, f } = matrix;
  const x0 = e * ptToPx;
  const y0 = f * ptToPx;
  const x1 = (e + a * imgWidthPx) * ptToPx;
  const y1 = (f + d * imgHeightPx) * ptToPx;
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  return { left, top, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

/** Junta uma imagem RGB com sua soft-mask (extraídas como dois arquivos separados por
 *  `pdfimages`) num PNG RGBA de verdade — canal alfa real, vindo do próprio PDF, não
 *  reconstruído por aproximação como em `pipeline.ts`. As duas precisam ter as mesmas
 *  dimensões (é como o PDF sempre as grava — a máscara é pixel-a-pixel do RGB). */
export async function combineWithSoftMask(rgb: Buffer, mask: Buffer): Promise<Buffer> {
  const rgbRaw = await sharp(rgb).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const maskRaw = await sharp(mask).raw().toBuffer({ resolveWithObject: true });
  if (rgbRaw.info.width !== maskRaw.info.width || rgbRaw.info.height !== maskRaw.info.height) {
    throw new Error("combineWithSoftMask: imagem e máscara têm tamanhos diferentes");
  }
  const { data, info } = rgbRaw;
  const maskChannels = maskRaw.info.channels;
  for (let i = 0, m = 0; i < data.length; i += 4, m += maskChannels) {
    data[i + 3] = maskRaw.data[m];
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** Recorta a foto-fonte de um elemento "moldura" (ex.: um emblema circular) pra só a região
 *  que aparece de verdade dentro do quadro — sem precisar isolar nada no Canva.
 *
 *  `imageBox` (devolvido por `read-design`) é relativo ao próprio quadro — o espaço local
 *  `0,0 .. frameWidth,frameHeight`, nunca à posição do quadro na página. É por isso que esta
 *  função recebe só o *tamanho* do quadro (`frameSize`), não uma posição: o pedaço visível da
 *  foto é sempre a região `0,0 .. frameSize.width,frameSize.height` desse espaço local,
 *  convertida pra pixels da própria foto pela escala entre `imageBox` e as dimensões nativas
 *  da imagem. O recorte em círculo/cantos arredondados continua sendo o `radius` do `El` no
 *  render do Blank Editor (`editableTweetTemplate.ts`), não algo feito aqui. */
export async function cropForFrame(
  sourceImage: Buffer,
  imageBox: Bbox,
  frameSize: { width: number; height: number },
): Promise<Buffer> {
  const meta = await sharp(sourceImage).metadata();
  const nativeWidth = meta.width!;
  const nativeHeight = meta.height!;
  const scaleX = nativeWidth / imageBox.width;
  const scaleY = nativeHeight / imageBox.height;

  const cropLeft = (0 - imageBox.left) * scaleX;
  const cropTop = (0 - imageBox.top) * scaleY;
  const cropWidth = frameSize.width * scaleX;
  const cropHeight = frameSize.height * scaleY;

  const left = Math.max(0, Math.round(cropLeft));
  const top = Math.max(0, Math.round(cropTop));
  const width = Math.min(nativeWidth - left, Math.round(cropWidth));
  const height = Math.min(nativeHeight - top, Math.round(cropHeight));

  return sharp(sourceImage).extract({ left, top, width, height }).png().toBuffer();
}
