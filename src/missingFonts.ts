/**
 * Fontes do PDF que o design importado ainda não tem. O import sempre tenta a fonte original
 * (biblioteca, depois fontes livres); quando não acha, usa uma parecida e deixa `fontOriginal`
 * no elemento. Daqui sai o aviso "fonte faltando" do editor e a troca de volta quando a pessoa
 * sobe a fonte certa. Tudo derivado dos elementos — nada a sincronizar, custo de um loop.
 */
import type { Page } from "./types";

// Hífen ("NewSpirit-SemiBold", nome do PDF) ou espaço ("New Spirit Bold", nome de arquivo).
const STYLE_SUFFIX = /[-\s]+(?:Regular|Reg|Rg|Bold|Bd|Italic|It|Light|Lt|Medium|Md|SemiBold|Semibold|Sb|ExtraBold|Black|Heavy|Thin|ExtraLight|BoldItalic|[A-Za-z]*Italic)$/i;

/** "NewSpirit-SemiBold" (formato antigo do import) -> "NewSpirit". */
export function originalFamily(fontOriginal: string): string {
  let n = fontOriginal;
  for (let i = 0; i < 3 && STYLE_SUFFIX.test(n); i++) n = n.replace(STYLE_SUFFIX, "");
  return n || fontOriginal;
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

export interface MissingWeights {
  family: string;
  /** Pesos/estilos que o design usa e que a família ainda não tem, ex. "Bold", "Italic". */
  missing: string[];
}

const WEIGHT_NAMES: Record<number, string> = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };

export function weightLabel(weight: number, italic: boolean): string {
  const name = WEIGHT_NAMES[Math.round(weight / 100) * 100] ?? String(weight);
  return italic ? (name === "Regular" ? "Italic" : `${name} Italic`) : name;
}

/** Pesos que faltam nas famílias que o design já tem registradas (`doc.fonts`): sem o arquivo
 *  do peso, o navegador "engorda" a fonte na marra e o texto não fica igual ao PDF. Famílias
 *  sem face nenhuma em `doc.fonts` (Inter embutida, fontes do sistema) ficam de fora. */
export function missingWeights(pages: Page[], fonts: Array<{ family: string; weight: number; style?: string }>): MissingWeights[] {
  const faces = new Map<string, Set<string>>();
  for (const f of fonts) {
    const key = familyKey(f.family);
    if (!faces.has(key)) faces.set(key, new Set());
    faces.get(key)!.add(`${f.weight}:${/italic|oblique/i.test(f.style ?? "")}`);
  }
  const out = new Map<string, { family: string; missing: Set<string> }>();
  const need = (family: string | undefined, weight: number | undefined, italic: boolean | undefined) => {
    if (!family) return;
    const have = faces.get(familyKey(family));
    if (!have) return;
    const w = weight ?? 400, it = !!italic;
    if (have.has(`${w}:${it}`)) return;
    const item = out.get(familyKey(family)) ?? { family, missing: new Set<string>() };
    item.missing.add(weightLabel(w, it));
    out.set(familyKey(family), item);
  };
  for (const page of pages) {
    for (const el of page.els) {
      if (el.type !== "text") continue;
      need(el.font, el.weight, el.italic);
      for (const r of el.runs ?? []) need(r.font ?? el.font, r.weight ?? el.weight, r.italic ?? el.italic);
    }
  }
  return [...out.values()].map((m) => ({ family: m.family, missing: [...m.missing] }));
}
