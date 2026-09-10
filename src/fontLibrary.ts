import { REPLACEMENT_PREFIX } from "../server/src/render/replacementFonts.ts";

/**
 * Biblioteca de fontes do painel "Fontes".
 *
 * É um catálogo curado, não o Google Fonts inteiro: ~56 famílias escolhidas, com preview
 * imediato e sem endpoint no servidor. As famílias que o index.html já carrega vêm de graça;
 * as outras entram sob demanda, uma folha de estilo por família, só quando alguém rola até
 * elas ou aplica uma — carregar 56 famílias de uma vez custaria megabytes por abrir o painel.
 */

export type FontCategory = "sans" | "serif" | "display" | "mono" | "hand";

export interface LibraryFont {
  family: string;
  category: FontCategory;
  /** Pesos pedidos ao Google Fonts. Uma família de peso único não leva eixo `wght` na URL. */
  weights: number[];
}

export const FONT_CATEGORIES: { id: FontCategory; label: string }[] = [
  { id: "sans", label: "Sem serifa" },
  { id: "serif", label: "Com serifa" },
  { id: "display", label: "Display" },
  { id: "mono", label: "Monoespaçada" },
  { id: "hand", label: "Manuscrita" },
];

/** Famílias que o <link> fixo do index.html já traz — nunca precisam de folha sob demanda. */
export const PRELOADED_FAMILIES = [
  "Inter", "Montserrat", "Space Grotesk", "IBM Plex Mono", "Playfair Display",
  "Bebas Neue", "Caveat", "Lora", "Oswald", "DM Serif Display",
];

const f = (family: string, category: FontCategory, weights: number[] = [400, 700]): LibraryFont => ({ family, category, weights });

export const FONT_LIBRARY: LibraryFont[] = [
  f("Inter", "sans", [400, 500, 600, 700]),
  f("Montserrat", "sans", [400, 500, 600, 700]),
  f("Space Grotesk", "sans", [400, 500, 600, 700]),
  f("Roboto", "sans", [400, 500, 700]),
  f("Open Sans", "sans", [400, 600, 700]),
  f("Lato", "sans", [400, 700]),
  f("Poppins", "sans", [400, 500, 600, 700]),
  f("Nunito", "sans", [400, 600, 700]),
  f("Work Sans", "sans", [400, 500, 600, 700]),
  f("Rubik", "sans", [400, 500, 700]),
  f("Manrope", "sans", [400, 500, 600, 700]),
  f("DM Sans", "sans", [400, 500, 700]),
  f("Karla", "sans", [400, 600, 700]),
  f("Barlow", "sans", [400, 500, 600, 700]),
  f("Figtree", "sans", [400, 500, 600, 700]),
  f("Outfit", "sans", [400, 500, 600, 700]),
  f("Plus Jakarta Sans", "sans", [400, 500, 600, 700]),
  f("Source Sans 3", "sans", [400, 600, 700]),
  f("Raleway", "sans", [400, 500, 600, 700]),
  f("Archivo", "sans", [400, 500, 600, 700]),
  f("Public Sans", "sans", [400, 500, 600, 700]),
  f("Mulish", "sans", [400, 600, 700]),

  f("Playfair Display", "serif", [400, 500, 600, 700]),
  f("Lora", "serif", [400, 500, 600, 700]),
  f("Merriweather", "serif", [400, 700]),
  f("Libre Baskerville", "serif", [400, 700]),
  f("EB Garamond", "serif", [400, 500, 600, 700]),
  f("Cormorant Garamond", "serif", [400, 500, 600, 700]),
  f("Source Serif 4", "serif", [400, 600, 700]),
  f("Crimson Text", "serif", [400, 600, 700]),
  f("PT Serif", "serif", [400, 700]),
  f("Bitter", "serif", [400, 500, 600, 700]),
  f("Spectral", "serif", [400, 500, 600, 700]),
  f("Zilla Slab", "serif", [400, 500, 600, 700]),
  f("Noto Serif", "serif", [400, 500, 600, 700]),
  f("Libre Caslon Text", "serif", [400, 700]),

  f("Bebas Neue", "display", [400]),
  f("Oswald", "display", [400, 500, 600, 700]),
  f("Anton", "display", [400]),
  f("DM Serif Display", "display", [400]),
  f("Abril Fatface", "display", [400]),
  f("Alfa Slab One", "display", [400]),
  f("Fjalla One", "display", [400]),
  f("Archivo Black", "display", [400]),
  f("Staatliches", "display", [400]),
  f("Bungee", "display", [400]),

  f("IBM Plex Mono", "mono", [400, 500, 700]),
  f("JetBrains Mono", "mono", [400, 500, 700]),
  f("Space Mono", "mono", [400, 700]),
  f("Roboto Mono", "mono", [400, 500, 700]),
  f("Fira Code", "mono", [400, 500, 700]),

  f("Caveat", "hand", [400, 700]),
  f("Pacifico", "hand", [400]),
  f("Dancing Script", "hand", [400, 700]),
  f("Shadows Into Light", "hand", [400]),
  f("Permanent Marker", "hand", [400]),
  f("Satisfy", "hand", [400]),
];

/**
 * Uma face resolvida na importação de PDF é guardada com o prefixo `Blank Complete `, que é
 * detalhe de armazenamento. Quem lê o painel deve ver só o nome da família.
 */
export function fontLabel(family: string): string {
  return family.startsWith(REPLACEMENT_PREFIX) ? family.slice(REPLACEMENT_PREFIX.length) : family;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

export function searchFontLibrary(options: { query?: string; category?: FontCategory | null } = {}): LibraryFont[] {
  const query = fold(options.query ?? "");
  return FONT_LIBRARY.filter((font) =>
    (!options.category || font.category === options.category) &&
    (!query || fold(font.family).includes(query)));
}

/**
 * As famílias que o design já carrega consigo. Elas não estão no catálogo — vieram de um PDF —
 * e sem esta seção, trocar a fonte de uma manchete importada seria irreversível pelo painel.
 */
export function designFamilies(families: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const family of families) {
    if (!family || seen.has(family)) continue;
    if (FONT_LIBRARY.some((font) => font.family === family)) continue;
    seen.add(family);
    result.push(family);
  }
  return result;
}

/** Trecho `family=` de uma família, no formato que o css2 do Google Fonts espera. */
function familyParam(font: LibraryFont): string {
  const name = font.family.replace(/ /g, "+");
  const weights = [...font.weights].sort((a, b) => a - b);
  const axis = weights.length > 1 || weights[0] !== 400 ? `:wght@${weights.join(";")}` : "";
  return `family=${name}${axis}`;
}

/** URL da folha de estilo do Google Fonts para uma família do catálogo. */
export function fontStylesheetUrl(font: LibraryFont): string {
  return `https://fonts.googleapis.com/css2?${familyParam(font)}&display=swap`;
}

/**
 * As folhas que cobrem o catálogo inteiro. O css2 aceita várias famílias por requisição, e uma
 * folha por família seriam 50+ requisições ao abrir o painel; mas a URL não pode crescer sem
 * limite, então isto entrega em blocos. As famílias que o index.html já traz ficam de fora.
 *
 * A folha só declara os `@font-face` — o navegador só baixa o arquivo da família que a página
 * realmente desenhar, que é o que faz o preview de cada nome custar o seu próprio arquivo e
 * nada mais.
 */
export function catalogStylesheetUrls(fonts: LibraryFont[] = FONT_LIBRARY, perRequest = 12): string[] {
  const pending = fonts.filter((font) => !PRELOADED_FAMILIES.includes(font.family));
  const urls: string[] = [];
  for (let i = 0; i < pending.length; i += perRequest) {
    urls.push(`https://fonts.googleapis.com/css2?${pending.slice(i, i + perRequest).map(familyParam).join("&")}&display=swap`);
  }
  return urls;
}
