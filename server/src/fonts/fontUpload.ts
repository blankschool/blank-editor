/**
 * Preparação de um arquivo de fonte enviado pela pessoa: aceita os formatos que ela
 * realmente tem em mãos (.ttf/.otf, e .woff/.woff2 baixados da web), devolve o SFNT puro que o
 * resto do pipeline usa, e lê família/peso/estilo — com mensagens de erro que dá para mostrar
 * na tela sem tradução.
 */
import { inflateSync } from "node:zlib";
import { decompress as woff2Decompress } from "wawoff2";
import { normalizeWeight, preferredFamilyName, readFamilyNames, readOs2WeightAndItalic } from "./sfntNames.ts";

/** Erro com texto pronto para o usuário (a rota devolve `message` direto no toast). */
export class FontUploadError extends Error {}

export const ACCEPTED_FONT_EXT = /\.(ttf|otf|woff2?)$/i;

function magic(bytes: Buffer): string {
  return bytes.length >= 4 ? bytes.toString("latin1", 0, 4) : "";
}

/** WOFF 1.0 -> SFNT: cabeçalho + diretório de tabelas, cada tabela opcionalmente zlib. */
export function woff1ToSfnt(woff: Buffer): Buffer {
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);
  const tables: Array<{ tag: string; data: Buffer; checksum: number }> = [];
  for (let i = 0; i < numTables; i++) {
    const r = 44 + i * 20;
    const tag = woff.toString("latin1", r, r + 4);
    const offset = woff.readUInt32BE(r + 4), compLength = woff.readUInt32BE(r + 8), origLength = woff.readUInt32BE(r + 12);
    const checksum = woff.readUInt32BE(r + 16);
    const raw = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? inflateSync(raw) : Buffer.from(raw);
    if (data.length !== origLength) throw new FontUploadError("Esse arquivo .woff está corrompido. Tente outro arquivo da fonte.");
    tables.push({ tag, data, checksum });
  }
  let searchRange = 1, entrySelector = 0;
  while (searchRange * 2 <= numTables) { searchRange *= 2; entrySelector++; }
  searchRange *= 16;
  const headerLen = 12 + 16 * numTables;
  const padded = (n: number) => (n + 3) & ~3;
  const total = headerLen + tables.reduce((s, t) => s + padded(t.data.length), 0);
  const out = Buffer.alloc(total);
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(numTables * 16 - searchRange, 10);
  let offset = headerLen;
  tables.forEach((t, i) => {
    const r = 12 + i * 16;
    out.write(t.tag, r, "latin1");
    out.writeUInt32BE(t.checksum, r + 4);
    out.writeUInt32BE(offset, r + 8);
    out.writeUInt32BE(t.data.length, r + 12);
    t.data.copy(out, offset);
    offset += padded(t.data.length);
  });
  return out;
}

/** Qualquer formato aceito -> SFNT (TrueType ou CFF/OTTO). */
export async function toSfnt(bytes: Buffer): Promise<{ sfnt: Buffer; ext: "ttf" | "otf" }> {
  let sfnt: Buffer;
  const m = magic(bytes);
  if (m === "wOF2") {
    try { sfnt = Buffer.from(await woff2Decompress(bytes)); }
    catch { throw new FontUploadError("Não conseguimos abrir esse arquivo .woff2. Tente a versão .ttf ou .otf da fonte."); }
  } else if (m === "wOFF") {
    try { sfnt = woff1ToSfnt(bytes); }
    catch (e) { throw e instanceof FontUploadError ? e : new FontUploadError("Não conseguimos abrir esse arquivo .woff. Tente a versão .ttf ou .otf da fonte."); }
  } else if (m === "ttcf") {
    throw new FontUploadError("Esse arquivo é uma coleção (.ttc) com várias fontes juntas. Envie o arquivo .ttf ou .otf de cada estilo.");
  } else if (m === "OTTO" || m === "true" || bytes.length >= 4 && bytes.readUInt32BE(0) === 0x00010000) {
    sfnt = bytes;
  } else {
    throw new FontUploadError("Esse arquivo não parece ser uma fonte. Envie um arquivo .ttf, .otf, .woff ou .woff2.");
  }
  return { sfnt, ext: magic(sfnt) === "OTTO" ? "otf" : "ttf" };
}

export interface FaceMetadata {
  family: string;
  weight: number;
  style: "Regular" | "Italic";
}

/** Família/peso/estilo a registrar. `overrides` vêm do formulário (ex.: completar a família que
 *  o design já usa); o resto sai do próprio arquivo. */
export function faceMetadata(sfnt: Buffer, overrides: { family?: string; weight?: string; style?: string } = {}): FaceMetadata {
  const family = (overrides.family || "").trim() || preferredFamilyName(sfnt) || readFamilyNames(sfnt)[0];
  if (!family) throw new FontUploadError("Não conseguimos ler o nome dessa fonte. Tente outro arquivo da mesma fonte.");
  const detected = readOs2WeightAndItalic(sfnt);
  const weight = overrides.weight ? normalizeWeight(Number(overrides.weight)) : normalizeWeight(detected.weight);
  const style = overrides.style ? (/italic|oblique/i.test(overrides.style) ? "Italic" : "Regular") : detected.italic ? "Italic" : "Regular";
  return { family, weight: weight ?? 400, style };
}
