/**
 * Fontes do PDF que o design importado ainda não tem. O import sempre tenta a fonte original
 * (biblioteca, depois fontes livres); quando não acha, usa uma parecida e deixa `fontOriginal`
 * no elemento. Daqui sai o aviso "fonte faltando" do editor e a troca de volta quando a pessoa
 * sobe a fonte certa. Tudo derivado dos elementos — nada a sincronizar, custo de um loop.
 */
import type { Page } from "./types";

const STYLE_SUFFIX = /-(?:Regular|Reg|Rg|Bold|Bd|Italic|It|Light|Lt|Medium|Md|SemiBold|Semibold|Sb|ExtraBold|Black|Heavy|Thin|ExtraLight|BoldItalic|[A-Za-z]*Italic)$/;

/** "NewSpirit-SemiBold" (formato antigo do import) -> "NewSpirit". */
export function originalFamily(fontOriginal: string): string {
  return fontOriginal.replace(STYLE_SUFFIX, "");
}

/** Chave de comparação: "New Spirit", "NewSpirit" e "newspirit" são a mesma família. */
export function familyKey(name: string): string {
  return originalFamily(name).normalize("NFD").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export interface MissingFont {
  family: string;
  /** Quantas caixas de texto usam a substituta. */
  count: number;
  /** Fonte usada no lugar, por enquanto. */
  replacement: string;
}

export function missingPdfFonts(pages: Page[]): MissingFont[] {
  const byKey = new Map<string, MissingFont>();
  for (const page of pages) {
    for (const el of page.els) {
      if (el.type !== "text" || !el.fontOriginal) continue;
      if (familyKey(el.font || "") === familyKey(el.fontOriginal)) continue;
      const key = familyKey(el.fontOriginal);
      const found = byKey.get(key);
      if (found) found.count++;
      else byKey.set(key, { family: originalFamily(el.fontOriginal), count: 1, replacement: el.font || "Inter" });
    }
  }
  return [...byKey.values()];
}

/** Troca a substituta pela fonte que a pessoa acabou de adicionar, em todas as páginas.
 *  Tira o `autoFit`: com a fonte certa, o corpo medido no PDF já é o certo. */
export function applyFontToOriginal(pages: Page[], original: string, family: string): number {
  const key = familyKey(original);
  let changed = 0;
  for (const page of pages) {
    for (const el of page.els) {
      if (el.type !== "text" || !el.fontOriginal || familyKey(el.fontOriginal) !== key) continue;
      el.font = family;
      delete el.fontOriginal;
      delete el.autoFit;
      changed++;
    }
  }
  return changed;
}
