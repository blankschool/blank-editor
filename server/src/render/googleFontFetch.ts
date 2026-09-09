/**
 * Baixa a face estática de uma Google Font que `googleFontMatch.ts` escolheu, sob demanda —
 * nunca um catálogo pré-embutido (ver o raciocínio de tamanho em builtinFaces.ts: o servidor
 * embute só Inter de propósito). `null` em qualquer falha de rede/parse: quem chama mantém o
 * fallback Inter que já funciona hoje, este módulo nunca deve ser motivo de um import falhar.
 *
 * Baixa TTF e WOFF2 num só passe: `uploadFontFace` (storage.ts) — o mesmo par que registra
 * fonte reconstruída de PDF — exige os dois formatos (TTF pro render no servidor, WOFF2 pro
 * editor no navegador via designFontLoader.ts).
 */
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FetchedGoogleFont {
  ttf: Buffer;
  woff2: Buffer;
  sha256: string;
}

type PlainFetch = (url: string, init?: RequestInit) => Promise<Response>;

const cacheDir = join(tmpdir(), "blank-editor-google-fonts");

function cachePathFor(family: string, weight: number, ext: "ttf" | "woff2"): string {
  // Nome de arquivo determinístico por família+peso — não por sha256 (que só sabemos DEPOIS
  // de baixar): é assim que a segunda chamada para o mesmo par acerta o cache sem rebaixar.
  const chave = `${family}-${weight}`.toLowerCase().replace(/[^a-z0-9-]+/g, "_");
  return join(cacheDir, `${chave}.${ext}`);
}

/**
 * A CSS2 API devolve blocos `@font-face` diferentes por user-agent: um UA sem suporte a WOFF2
 * força um único bloco `.ttf` cobrindo tudo; um UA moderno devolve VÁRIOS blocos `.woff2`
 * fatiados por `unicode-range` (cyrillic, vietnamese, latin-ext, latin...). Latin (U+0000-00FF)
 * é o subset que cobre ASCII + acentos comuns em português (á é í ó ú ã õ ç), então é o que
 * interessa aqui — pegar o primeiro bloco cairia no cyrillic/vietnamese na maioria das fontes.
 */
function urlDaFonte(css: string, exigirLatin: boolean): string | null {
  if (!exigirLatin) {
    const match = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
    return match ? match[1] : null;
  }
  const blocos = css.split("@font-face");
  const latino = blocos.find((b) => /unicode-range:[^;]*U\+0000-00FF/.test(b)) ?? blocos[blocos.length - 1];
  const match = latino.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
  return match ? match[1] : null;
}

async function baixarVariante(
  fetchJson: PlainFetch, family: string, weight: number, userAgent: string, exigirLatin: boolean,
): Promise<Buffer | null> {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&display=swap`;
  const cssResponse = await fetchJson(cssUrl, { headers: { "User-Agent": userAgent } });
  if (!cssResponse.ok) return null;
  const fontUrl = urlDaFonte(await cssResponse.text(), exigirLatin);
  if (!fontUrl) return null;
  const fontResponse = await fetchJson(fontUrl);
  if (!fontResponse.ok) return null;
  const bytes = Buffer.from(await fontResponse.arrayBuffer());
  return bytes.length ? bytes : null;
}

export async function fetchGoogleFontFace(
  family: string,
  weight: number,
  deps: { fetchJson?: PlainFetch } = {},
): Promise<FetchedGoogleFont | null> {
  const fetchJson = deps.fetchJson ?? fetch;
  const ttfCache = cachePathFor(family, weight, "ttf");
  const woff2Cache = cachePathFor(family, weight, "woff2");
  if (existsSync(ttfCache) && existsSync(woff2Cache)) {
    const ttf = readFileSync(ttfCache);
    const woff2 = readFileSync(woff2Cache);
    return { ttf, woff2, sha256: createHash("sha256").update(ttf).digest("hex") };
  }

  try {
    // UA "sem suporte a woff2" força a CSS2 API a listar .ttf; UA moderno lista .woff2.
    const [ttf, woff2] = await Promise.all([
      baixarVariante(fetchJson, family, weight, "Mozilla/5.0 (Windows NT 6.1)", false),
      baixarVariante(fetchJson, family, weight, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36", true),
    ]);
    if (!ttf || !woff2) return null;

    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(ttfCache, ttf);
    writeFileSync(woff2Cache, woff2);
    return { ttf, woff2, sha256: createHash("sha256").update(ttf).digest("hex") };
  } catch {
    return null;
  }
}
