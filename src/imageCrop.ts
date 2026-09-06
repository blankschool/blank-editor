/** Recorte de imagem independente da moldura (backlog 2.3) — um retângulo 0..1 relativo à
 *  imagem ORIGINAL, não ao box do elemento. `imgW`/`imgH` ausentes (undefined) significa
 *  "sem recorte próprio": os renderers caem de volta no "cover" automático de sempre. */
export interface ImageCrop {
  imgX?: number;
  imgY?: number;
  imgW?: number;
  imgH?: number;
}

function clampCrop(crop: ImageCrop): { x: number; y: number; w: number; h: number } {
  const w = Math.max(1e-6, Math.min(1, crop.imgW ?? 1));
  const h = Math.max(1e-6, Math.min(1, crop.imgH ?? 1));
  const x = Math.max(0, Math.min(1 - w, crop.imgX ?? 0));
  const y = Math.max(0, Math.min(1 - h, crop.imgY ?? 0));
  return { x, y, w, h };
}

/** Pra renderizar em CSS puro (elInner): `background-size` em % é relativo ao CONTAINER, então
 *  o inverso da fração recortada faz esse tanto da imagem preencher a caixa. `background-position`
 *  em % não é a origem do recorte em si — é a fórmula padrão do CSS,
 *  `offset / (tamanhoEscalado - tamanhoContainer)` — por isso a divisão por `(1 - crop)`. */
export function cropToBackgroundStyle(crop: ImageCrop): { sizePct: [number, number]; positionPct: [number, number] } {
  const { x, y, w, h } = clampCrop(crop);
  const posX = w >= 1 ? 0 : (x / (1 - w)) * 100;
  const posY = h >= 1 ? 0 : (y / (1 - h)) * 100;
  return { sizePct: [100 / w, 100 / h], positionPct: [posX, posY] };
}

/** Pra desenhar em canvas (drawEl): a janela recortada da imagem ORIGINAL vira a origem do
 *  `drawImage`, em pixels reais — precisa do tamanho natural da imagem carregada. */
export function cropToSourceRect(
  crop: ImageCrop,
  naturalWidth: number,
  naturalHeight: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const { x, y, w, h } = clampCrop(crop);
  return {
    sx: x * naturalWidth,
    sy: y * naturalHeight,
    sw: Math.max(1, w * naturalWidth),
    sh: Math.max(1, h * naturalHeight),
  };
}
