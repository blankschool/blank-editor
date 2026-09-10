import { REPLACEMENT_PREFIX } from "../server/src/render/replacementFonts.ts";

/** Famílias que o index.html carrega e que qualquer design pode usar. */
export const FONTS = ["Inter", "Space Grotesk", "Montserrat", "Playfair Display", "Lora", "Oswald", "Bebas Neue", "DM Serif Display", "Caveat"];

/**
 * Um design importado de PDF desenha com a família que o resolvedor achou (Libre Caslon
 * Condensed, uma do Google Fonts, ou o nome cru do PDF) — nenhuma delas está em FONTS. Sem uma
 * opção correspondente o <select> cai na primeira da lista e diz "Inter" enquanto o canvas
 * mostra outra coisa. Então a família do elemento entra na lista sempre que faltar.
 */
export function fontOptions(current: string | undefined): { value: string; label: string; selected: boolean }[] {
  const families = current && !FONTS.includes(current) ? [current, ...FONTS] : FONTS;
  return families.map((value) => ({
    value,
    label: value.startsWith(REPLACEMENT_PREFIX) ? value.slice(REPLACEMENT_PREFIX.length) : value,
    selected: value === current,
  }));
}
