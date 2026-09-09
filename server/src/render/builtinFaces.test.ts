import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { builtinFaces } from "./builtinFaces.ts";
import { resolveFaces, listUsedFamilies } from "./resolveFonts.ts";
import { DEFAULT_FONT_FAMILY } from "./editableTweetTemplate.ts";

test("a família padrão sempre tem face, mesmo sem documento nem conta declararem nada", () => {
  // Este é o 400 que os templates iniciais produziam: eles usam Inter e não declaram fontes,
  // então sem as embutidas o resolveFaces lançava "não declara nenhuma face para ela".
  const pagina = { els: [{ type: "text", font: DEFAULT_FONT_FAMILY, text: "oi" }] };
  assert.doesNotThrow(() => resolveFaces(builtinFaces(), listUsedFamilies(pagina)));
});

test("sem as embutidas o mesmo render falha — o teste acima não passa por acidente", () => {
  const pagina = { els: [{ type: "text", font: DEFAULT_FONT_FAMILY, text: "oi" }] };
  assert.throws(() => resolveFaces([], listUsedFamilies(pagina)), /não declara nenhuma face/);
});

test("cobre os pesos estáticos usuais da Inter, não só 400 e 700", () => {
  const pesos = builtinFaces().map((f) => f.weight).sort((a, b) => a - b);
  assert.deepEqual(pesos, [300, 400, 500, 600, 700, 800]);
  for (const f of builtinFaces()) assert.equal(f.family, DEFAULT_FONT_FAMILY);
});

test("o sha256 declarado bate com os bytes em disco", () => {
  // ensureFontFiles recusa a face se o hash não conferir, então um arquivo trocado sem o hash
  // acompanhar viraria erro de render em produção — aqui vira teste vermelho.
  for (const f of builtinFaces()) {
    assert.ok(isAbsolute(f.src), `src precisa ser caminho absoluto: ${f.src}`);
    const real = createHash("sha256").update(readFileSync(f.src)).digest("hex");
    assert.equal(f.sha256, real, `hash divergente para ${f.src}`);
  }
});

test("faces embutidas são fontes completas, não subset", () => {
  // `glyphs` presente faria assertGlyphCoverage restringir o texto que pode ser desenhado.
  for (const f of builtinFaces()) assert.equal(f.glyphs, undefined);
});
