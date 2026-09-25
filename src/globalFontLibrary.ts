import type { DocFont } from "./types.ts";

export interface RegisteredFontFace {
  internalFamily: string;
  weight: number;
  style: string;
  sha256: string;
  sfntPath: string;
  woff2Path: string;
}

export function registeredDocFont(face: RegisteredFontFace): DocFont {
  return { family: face.internalFamily, weight: face.weight, style: face.style,
    sha256: face.sha256, ttf: face.sfntPath, woff2: face.woff2Path };
}

export async function fetchGlobalFonts(): Promise<DocFont[]> {
  const response = await fetch("/api/v1/fonts", { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error("Não foi possível carregar as fontes compartilhadas.");
  const faces: RegisteredFontFace[] = await response.json();
  return faces.map(registeredDocFont);
}

/** O documento conserva suas faces; a biblioteca só preenche pesos/estilos ausentes. */
export function withGlobalFontFamily(existing: DocFont[], catalog: DocFont[], family: string): DocFont[] {
  const result = [...existing];
  const slot = (f: DocFont) => `${f.family}:${f.weight}:${/italic|oblique/i.test(f.style ?? "") ? "italic" : "normal"}`;
  const slots = new Set(existing.map(slot));
  for (const face of catalog) {
    if (face.family !== family || slots.has(slot(face))) continue;
    result.push({ ...face });
    slots.add(slot(face));
  }
  return result;
}
