/**
 * Roda `scripts/canva-pdf-fonts.py` (fontes + texto vetorial) e devolve os dois num formato
 * pronto pro `orchestrate.ts` juntar com as imagens.
 *
 * Único passo do pipeline que não é Node: reconstruir contornos TrueType pede fontTools, sem
 * equivalente prático em JS — ver o cabeçalho do próprio script.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "canva-pdf-fonts.py");

export interface ExtractedFont {
  familia: string;
  estilo: string;
  peso: number;
  glifos: string;
  sha256: string;
  postscriptName?: string;
  stretch?: string;
  os2FsType?: number;
  ttf: Buffer;
  woff2: Buffer;
}

export interface ExtractedTextElement {
  type: "text";
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  font: string;
  weight: number;
  size: number;
  fill: string;
  rot: number;
}

export interface PythonExtractResult {
  fonts: ExtractedFont[];
  textByPage: Map<number, ExtractedTextElement[]>;
}

interface RawFontEntry {
  arquivo: string;
  familia: string;
  estilo: string;
  peso: number;
  texto: string;
  sha256: string;
  postscript_name?: string;
  stretch?: string;
  os2_fs_type?: number;
}

interface RawTextPage {
  page: number;
  elements: ExtractedTextElement[];
}

export async function extractFontsAndText(pdfPath: string, workDir: string): Promise<PythonExtractResult> {
  // Lido aqui dentro, não numa constante de módulo: imports ESM são resolvidos (e o corpo do
  // módulo executado) antes do código de nível superior de quem importou rodar — inclusive antes
  // do `process.loadEnvFile(".env")` de server.ts. Uma constante de módulo teria congelado o
  // fallback "python3" pra sempre, mesmo com CANVA_IMPORT_PYTHON definido no .env.
  const PYTHON = process.env.CANVA_IMPORT_PYTHON || "python3";
  try {
    await run(PYTHON, [scriptPath, pdfPath, workDir], { maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr) : "";
    throw new Error(`extração de fontes/texto falhou: ${stderr.slice(-2000) || (error as Error).message}`);
  }

  const rawFonts = JSON.parse(await readFile(resolve(workDir, "fonts.json"), "utf8")) as RawFontEntry[];
  const rawText = JSON.parse(await readFile(resolve(workDir, "text.json"), "utf8")) as RawTextPage[];

  const fonts = await Promise.all(
    rawFonts.map(async (f): Promise<ExtractedFont> => ({
      familia: f.familia,
      estilo: f.estilo,
      peso: f.peso,
      glifos: f.texto,
      sha256: f.sha256,
      postscriptName: f.postscript_name,
      stretch: f.stretch,
      os2FsType: f.os2_fs_type,
      ttf: await readFile(resolve(workDir, `${f.arquivo}.ttf`)),
      woff2: await readFile(resolve(workDir, `${f.arquivo}.woff2`)),
    })),
  );

  const textByPage = new Map<number, ExtractedTextElement[]>();
  for (const entry of rawText) textByPage.set(entry.page, entry.elements);

  return { fonts, textByPage };
}
