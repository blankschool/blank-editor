/**
 * Detecta uma página achatada: exportada como foto da tela em vez de conteúdo vetorial. Regra
 * portada do `converter()` do repo blank-editor-313c0b78 (canva-import/servico.py): zero texto
 * extraído E coberta por uma única imagem do tamanho da página inteira.
 */
export interface FlatCheckElement {
  type: "text" | "image";
  w: number;
  h: number;
}

const COBERTURA_MINIMA = 0.9; // tolerância pra margem/sangria da exportação

export function isFlattenedPage(elements: FlatCheckElement[], canvas: { w: number; h: number }): boolean {
  if (elements.some((el) => el.type === "text")) return false;
  const images = elements.filter((el) => el.type === "image");
  if (images.length !== 1) return false;
  const [image] = images;
  return image.w >= canvas.w * COBERTURA_MINIMA && image.h >= canvas.h * COBERTURA_MINIMA;
}
