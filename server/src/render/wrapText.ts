/**
 * Approximate glyph width per point size, for a proportional sans-serif font.
 * There is no real font metrics engine here (no browser, no canvas) — this
 * ratio is tuned against Inter/system-ui and is good enough to keep wraps and
 * single-line positioning visually close, not pixel-perfect. Exported so every
 * caller (wrapping, single-line layout) shares one number instead of drifting.
 */
const AVG_CHAR_WIDTH_RATIO = 0.52;
const CONDENSED_CHAR_WIDTH_RATIO = 0.42;

function widthRatio(fontFamily?: string): number {
  return /condensed|condensad/i.test(fontFamily ?? "") ? CONDENSED_CHAR_WIDTH_RATIO : AVG_CHAR_WIDTH_RATIO;
}

function estimateTextWidth(text: string, fontSize: number, fontFamily?: string): number {
  return text.length * fontSize * widthRatio(fontFamily);
}

function wrapParagraph(paragraph: string, maxWidth: number, fontSize: number, fontFamily?: string): string[] {
  if (paragraph === "") return [""];

  const words = paragraph.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (estimateTextWidth(candidate, fontSize, fontFamily) <= maxWidth || current === "") {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current !== "") lines.push(current);

  return lines.flatMap((line) => breakLongWord(line, maxWidth, fontSize, fontFamily));
}

function breakLongWord(line: string, maxWidth: number, fontSize: number, fontFamily?: string): string[] {
  if (estimateTextWidth(line, fontSize, fontFamily) <= maxWidth) return [line];

  const maxChars = Math.max(1, Math.floor(maxWidth / (fontSize * widthRatio(fontFamily))));
  const chunks: string[] = [];
  for (let i = 0; i < line.length; i += maxChars) {
    chunks.push(line.slice(i, i + maxChars));
  }
  return chunks;
}

/** Wraps `text` into lines that fit `maxWidth` px at `fontSize`, honouring `\n` paragraph breaks. */
export function wrapText(text: string, maxWidth: number, fontSize: number, fontFamily?: string): string[] {
  return text.split("\n").flatMap((paragraph) => wrapParagraph(paragraph, maxWidth, fontSize, fontFamily));
}
