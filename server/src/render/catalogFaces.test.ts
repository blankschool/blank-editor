import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { catalogFaces } from "./catalogFaces.ts";
import { builtinFaces } from "./builtinFaces.ts";
import { resolveFaces, listUsedFamilies } from "./resolveFonts.ts";

test("uma família auto-hospedada do catálogo renderiza sem o design declarar face nenhuma", () => {
  const pagina = { els: [{ type: "text", font: "Chirp", text: "oi" }] };
  assert.doesNotThrow(() => resolveFaces([...builtinFaces(), ...catalogFaces()], listUsedFamilies(pagina)));
  assert.throws(() => resolveFaces(builtinFaces(), listUsedFamilies(pagina)), /não declara nenhuma face/);
});

test("os pesos batem com os que o painel oferece, e o sha256 com os bytes em disco", () => {
  const chirp = catalogFaces().filter((f) => f.family === "Chirp");
  assert.deepEqual(chirp.map((f) => f.weight).sort((a, b) => a - b), [400, 500, 700, 800]);
  for (const f of catalogFaces()) {
    assert.ok(isAbsolute(f.src), `src precisa ser caminho absoluto: ${f.src}`);
    assert.equal(f.sha256, createHash("sha256").update(readFileSync(f.src)).digest("hex"), `hash divergente para ${f.src}`);
    // `glyphs` presente restringiria o texto desenhável: estas são fontes completas.
    assert.equal(f.glyphs, undefined);
  }
});
