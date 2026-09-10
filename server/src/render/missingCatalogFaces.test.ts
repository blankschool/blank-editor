import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fetchMissingCatalogFaces } from "./missingCatalogFaces.ts";
import { listUsedFaces, resolveFaces, listUsedFamilies } from "./resolveFonts.ts";
import { builtinFaces } from "./builtinFaces.ts";

const bytes = (marca: string) => Buffer.from(`ttf-${marca}`);
const fake = (marca: string) => ({
  ttf: bytes(marca), woff2: bytes(marca),
  sha256: createHash("sha256").update(bytes(marca)).digest("hex"),
});

test("uma família do painel que ninguém declarou é buscada, e o render deixa de parar", async () => {
  const pagina = { els: [{ type: "text", font: "IBM Plex Mono", weight: 500, text: "oi" }] };
  const usadas = listUsedFaces(pagina);
  assert.deepEqual(usadas, [{ family: "IBM Plex Mono", weight: 500 }]);

  const pedidos: string[] = [];
  const buscadas = await fetchMissingCatalogFaces(usadas, builtinFaces(), {
    fetchFace: async (family, weight) => { pedidos.push(`${family}/${weight}`); return fake(family); },
  });
  assert.deepEqual(pedidos, ["IBM Plex Mono/500"]);
  assert.equal(buscadas[0].family, "IBM Plex Mono");
  assert.equal(readFileSync(buscadas[0].src).toString(), "ttf-IBM Plex Mono");
  assert.doesNotThrow(() => resolveFaces([...builtinFaces(), ...buscadas], listUsedFamilies(pagina)));
});

test("não busca o que já está coberto, nem o que o Google nunca teria", async () => {
  const pedidos: string[] = [];
  const fetchFace = async (family: string) => { pedidos.push(family); return fake(family); };
  const buscadas = await fetchMissingCatalogFaces(
    [
      { family: "Inter", weight: 700 },              // já vem embutida
      { family: "Blank Complete Arimo", weight: 400 }, // face de substituição, não é do Google
      { family: "ABCDEF+PanicoSans", weight: 400 },    // subset extraído de PDF
    ],
    builtinFaces(), { fetchFace },
  );
  assert.deepEqual(pedidos, []);
  assert.deepEqual(buscadas, []);
});

test("uma busca que falha não vira um jeito novo de o render quebrar", async () => {
  const semRede = await fetchMissingCatalogFaces([{ family: "Karla", weight: 400 }], [], {
    fetchFace: async () => { throw new Error("sem rede"); },
  });
  assert.deepEqual(semRede, []);
  const semResultado = await fetchMissingCatalogFaces([{ family: "Karla", weight: 400 }], [], {
    fetchFace: async () => null,
  });
  assert.deepEqual(semResultado, []);
});
