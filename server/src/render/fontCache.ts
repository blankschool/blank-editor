import { createHash } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchImage } from "./imageSource.ts";
import { FONT_SFNT_PREFIX, fetchFontSfnt } from "../storage.ts";

/**
 * As fontes de um design, em disco, prontas para o `Resvg`.
 *
 * O rasterizador não resolve fonte por nome do sistema (`loadSystemFonts: false`): ele recebe
 * uma lista de ARQUIVOS e monta um banco de fontes próprio para aquela renderização. Este
 * módulo é quem transforma "o documento declara estas faces" em "estes caminhos existem".
 *
 * Substitui `designFonts.ts`, que tentava o caminho oposto — registrar as fontes no fontconfig
 * do processo via `FONTCONFIG_FILE`. Não funciona: o fontconfig lê a configuração uma vez e
 * ignora mudanças depois, então uma fonte que chega junto com o documento nunca era vista.
 *
 * O cache é por `sha256` do arquivo, não por URL: a mesma face usada em dez designs baixa uma
 * vez só, e um design antigo nunca muda de aparência porque alguém subiu bytes diferentes na
 * mesma URL.
 */

export interface FaceRef {
  family: string;
  weight: number;
  style?: "normal" | "italic";
  /** sha256 dos bytes do SFNT — a identidade da face e a chave do cache. */
  sha256: string;
  /** De onde buscar em caso de cache miss: URL http(s), ou caminho absoluto local. */
  src: string;
  /** Browser font used by the editor; PDF conversion may give the TTF different metrics. */
  browserSrc?: string;
  /** Só os glifos que esta face contém, quando ela é um subset (o caso de fonte extraída de
   *  PDF). Ausente = fonte completa, sem restrição a verificar. */
  glyphs?: string;
}

const cacheDir = join(tmpdir(), "blank-editor-fonts");

/** O SFNT vive num bucket PRIVADO (só service-role lê), então buscá-lo não é um fetch qualquer.
 *  Configurado no boot como singleton, igual ao cliente de Storage do renderTweet. */
let storageClient: SupabaseClient | null = null;
export function configureFontStorage(client: SupabaseClient | null): void {
  storageClient = client;
}

function pathFor(sha256: string): string {
  return join(cacheDir, `${sha256}.ttf`);
}

/** Lança em vez de devolver bytes errados: um sha que não confere significa que a face não é a
 *  que o documento declarou, e desenhar com ela silenciosamente é o tipo de falha que este
 *  módulo existe para impedir. */
function assertSha(bytes: Buffer, expected: string, src: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`fonte em ${src} não confere: esperado sha256 ${expected}, obtido ${actual}`);
  }
}

async function readSource(src: string): Promise<Buffer> {
  if (src.startsWith(FONT_SFNT_PREFIX)) {
    if (!storageClient) throw new Error("fonte no bucket privado, mas nenhum cliente de Storage configurado");
    return fetchFontSfnt(storageClient, src);
  }

  // Caminho absoluto: usado pelo seed local e pelos testes, que não têm storage nem rede. O
  // fetch guardado (`fetchImage`) recusa host privado de propósito, então não serve para isso.
  if (isAbsolute(src)) {
    const { readFile } = await import("node:fs/promises");
    return readFile(src);
  }
  return fetchImage(src);
}

/**
 * Garante que cada face esteja em disco e devolve os caminhos, na ordem recebida.
 *
 * Falha alto: uma face que não baixa derruba a renderização inteira. O contrário — seguir sem
 * ela — desenharia o texto com outra fonte, com outra largura, e o resultado sairia
 * silenciosamente errado.
 */
export async function ensureFontFiles(faces: readonly FaceRef[]): Promise<string[]> {
  if (!faces.length) return [];
  mkdirSync(cacheDir, { recursive: true });

  return Promise.all(
    faces.map(async (face) => {
      const target = pathFor(face.sha256);
      if (existsSync(target)) return target;
      let bytes: Buffer;
      try {
        bytes = await readSource(face.src);
      } catch (cause) {
        throw new Error(`não consegui obter a fonte ${face.family} ${face.weight} (${face.src}): ${(cause as Error).message}`);
      }
      assertSha(bytes, face.sha256, face.src);
      writeFileSync(target, bytes);
      return target;
    }),
  );
}
