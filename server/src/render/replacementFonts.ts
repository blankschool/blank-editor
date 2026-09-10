export const REPLACEMENT_PREFIX = "Blank Complete ";
export const REPLACEMENT_FAMILIES = ["Arimo", "Tinos", "Cousine", "Carlito", "Caladea", "Inter"] as const;
export type FontCategory = "serif" | "sans" | "mono";

export function replacementFamily(original: string, category?: FontCategory): string {
  const name = original.replace(/^[A-Z]{6}\+/, "").toLowerCase().replace(/[\s_-]/g, "");
  if (/^(arial|helvetica|arimo)/.test(name)) return "Arimo";
  if (/^(times|tinos)/.test(name)) return "Tinos";
  if (/^(courier|cousine)/.test(name) || category === "mono") return "Cousine";
  if (/^(calibri|carlito)/.test(name)) return "Carlito";
  if (/^(cambria|caladea)/.test(name)) return "Caladea";
  if (category === "sans") return "Inter";
  if (category === "serif" || /serif|caslon|baskerville|garamond|georgia|palatino|bodoni|didot|bookman|merriweather|playfair|lora/.test(name)) return "Tinos";
  return "Inter";
}

export const replacementFontFiles = REPLACEMENT_FAMILIES.flatMap(family => [400, 700].flatMap(weight => [false, true].map(italic => ({
  family: REPLACEMENT_PREFIX + family, weight, style: italic ? "italic" as const : "normal" as const,
  file: family === "Arimo" || family === "Inter"
    ? `${family}-${italic ? "Italic" : "Regular"}-Variable.ttf`
    : `${family}-${weight === 700 ? (italic ? "BoldItalic" : "Bold") : (italic ? "Italic" : "Regular")}.ttf`,
}))));

interface EditableText {
  text?: string;
  font?: string;
  weight?: number;
  italic?: boolean;
  fontCategory?: FontCategory;
  fontOriginal?: string;
  runs?: unknown;
  autoFit?: boolean;
  fontStyle?: string;
}
interface DeclaredFont { family: string; glyphs?: string; subset?: boolean; style?: string; weight?: number }

/** Normalize once, before an imported page is ever displayed or saved. */
export function normalizeImportedText<T extends EditableText>(element: T): T {
  const original = element.fontOriginal || element.font || "";
  return {
    ...element, font: REPLACEMENT_PREFIX + replacementFamily(original, element.fontCategory),
    weight: Number(element.weight) >= 600 ? 700 : 400,
    italic: Boolean(element.italic || /italic|oblique/i.test(element.fontStyle || original)),
    autoFit: true,
  };
}

/** Original text keeps its exact PDF face. A changed field never reuses a PDF subset. */
export function replaceTemplateText<T extends EditableText>(element: T, text: string, fonts: readonly DeclaredFont[] = []): T {
  if (text === element.text) return element;
  const { runs: _runs, ...base } = element;
  const subsetFaces = fonts.filter(f => f.family === element.font && (f.glyphs !== undefined || f.subset === true));
  const imported = subsetFaces.length > 0 || Boolean(element.fontOriginal);
  if (!imported || element.font?.startsWith(REPLACEMENT_PREFIX)) return { ...base, text, autoFit: true } as T;
  const originalChars = [...(element.text || "")];
  const score = (f: DeclaredFont) => originalChars.filter(c => f.glyphs?.includes(c)).length;
  const face = subsetFaces.reduce<DeclaredFont | undefined>((best, f) => !best || score(f) > score(best) ? f : best, undefined);
  return {
    ...base, text, autoFit: true,
    font: REPLACEMENT_PREFIX + replacementFamily(element.fontOriginal || element.font || "", element.fontCategory),
    weight: Number(element.weight) >= 600 ? 700 : 400,
    italic: Boolean(element.italic || /italic|oblique/i.test(face?.style || "")),
  } as T;
}
