import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchGoogleFontFace } from "./googleFontFetch.ts";

const CSS_TTF_MOCK = `@font-face {
  font-family: 'Teste';
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/teste/v1/ttf123.ttf) format('truetype');
}`;

const CSS_WOFF2_MOCK = `@font-face {
  font-family: 'Teste';
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/teste/v1/cyrillic.woff2) format('woff2');
  unicode-range: U+0400-045F;
}
@font-face {
  font-family: 'Teste';
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/teste/v1/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}`;

// O cache do módulo é em disco (tmpdir), por nome de família+peso, e sobrevive entre execuções
// deste arquivo de teste — um nome fixo faria a segunda rodada local acertar o cache e nunca
// chamar `fetchJson`, dando falso positivo/negativo. Um sufixo por processo evita a colisão.
const unico = (n: number) => `Familia De Teste Unico ${process.pid}-${n}`;

function mockFetch(bytesPorUrl: Record<string, Buffer>) {
  const urls: string[] = [];
  const fetchJson = async (url: string, init?: RequestInit) => {
    urls.push(url);
    const ua = new Headers(init?.headers).get("user-agent") ?? "";
    if (url.startsWith("https://fonts.googleapis.com")) {
      return new Response(ua.includes("Chrome") ? CSS_WOFF2_MOCK : CSS_TTF_MOCK, { status: 200 });
    }
    const bytes = bytesPorUrl[url];
    return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response("not found", { status: 404 });
  };
  return { fetchJson, urls };
}

test("baixa TTF (UA antigo) e WOFF2 latin (UA moderno, ignorando o bloco cyrillic) com o mesmo sha256 do TTF", async () => {
  const ttfBytes = Buffer.from("bytes ttf de teste");
  const woff2Bytes = Buffer.from("bytes woff2 latin");
  const { fetchJson, urls } = mockFetch({
    "https://fonts.gstatic.com/s/teste/v1/ttf123.ttf": ttfBytes,
    "https://fonts.gstatic.com/s/teste/v1/latin.woff2": woff2Bytes,
    "https://fonts.gstatic.com/s/teste/v1/cyrillic.woff2": Buffer.from("nao deveria pegar este"),
  });
  const resultado = await fetchGoogleFontFace(unico(1), 700, { fetchJson });
  assert.ok(resultado);
  assert.deepEqual(resultado!.ttf, ttfBytes);
  assert.deepEqual(resultado!.woff2, woff2Bytes);
  assert.match(resultado!.sha256, /^[0-9a-f]{64}$/);
  assert.ok(urls.some((u) => u.endsWith("latin.woff2")), "deveria ter baixado o bloco latin, não o cyrillic");
});

test("CSS sem nenhuma URL de fonte devolve null", async () => {
  const resultado = await fetchGoogleFontFace(unico(2), 400, {
    fetchJson: async () => new Response("@font-face { font-family: 'X'; }", { status: 200 }),
  });
  assert.equal(resultado, null);
});

test("CSS2 respondendo não-ok (família inexistente) devolve null", async () => {
  const resultado = await fetchGoogleFontFace(unico(3), 400, {
    fetchJson: async () => new Response("not found", { status: 400 }),
  });
  assert.equal(resultado, null);
});

test("erro de rede devolve null em vez de lançar", async () => {
  const resultado = await fetchGoogleFontFace(unico(4), 400, {
    fetchJson: async () => { throw new Error("network down"); },
  });
  assert.equal(resultado, null);
});

test("se o WOFF2 falhar mas o TTF funcionar, devolve null (precisa dos dois formatos)", async () => {
  const resultado = await fetchGoogleFontFace(unico(6), 400, {
    fetchJson: async (url, init) => {
      const ua = new Headers(init?.headers).get("user-agent") ?? "";
      if (url.startsWith("https://fonts.googleapis.com")) {
        return ua.includes("Chrome") ? new Response("sem fonte nenhuma aqui", { status: 200 }) : new Response(CSS_TTF_MOCK, { status: 200 });
      }
      return new Response(Buffer.from("ttf ok"), { status: 200 });
    },
  });
  assert.equal(resultado, null);
});

test("segunda chamada para o mesmo par usa o cache em disco, sem bater na rede de novo", async () => {
  const ttfBytes = Buffer.from("ttf cacheavel");
  const woff2Bytes = Buffer.from("woff2 cacheavel");
  let chamadasDeRede = 0;
  const { fetchJson: base } = mockFetch({
    "https://fonts.gstatic.com/s/teste/v1/ttf123.ttf": ttfBytes,
    "https://fonts.gstatic.com/s/teste/v1/latin.woff2": woff2Bytes,
    "https://fonts.gstatic.com/s/teste/v1/cyrillic.woff2": Buffer.from("x"),
  });
  const fetchJson: typeof base = async (url, init) => { chamadasDeRede++; return base(url, init); };

  const primeira = await fetchGoogleFontFace(unico(5), 400, { fetchJson });
  const chamadasAposPrimeira = chamadasDeRede;
  const segunda = await fetchGoogleFontFace(unico(5), 400, { fetchJson });
  assert.equal(chamadasDeRede, chamadasAposPrimeira, "a segunda chamada não deveria bater na rede");
  assert.deepEqual(segunda!.ttf, primeira!.ttf);
  assert.deepEqual(segunda!.woff2, primeira!.woff2);
});
