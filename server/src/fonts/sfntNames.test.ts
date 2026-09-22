import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFamilyNames, familyMatchesFile, readOs2WeightAndItalic } from "./sfntNames.ts";
import { FIXTURE_FONT_PATH, FIXTURE_FAMILY } from "../render/__fixtures__/fixtureFont.ts";

const BYTES = readFileSync(FIXTURE_FONT_PATH);

test("lê o nome de família de dentro do arquivo", () => {
  assert.deepEqual(readFamilyNames(BYTES), [FIXTURE_FAMILY]);
});

test("aceita a família que o arquivo realmente declara", () => {
  assert.equal(familyMatchesFile(FIXTURE_FAMILY, BYTES).ok, true);
});

test("recusa família que o arquivo não declara — a defesa contra 'registrei Inter mas subi outra fonte'", () => {
  const r = familyMatchesFile("Inter", BYTES);
  assert.equal(r.ok, false);
  assert.deepEqual(r.noArquivo, [FIXTURE_FAMILY]);
});

test("ignora caixa e espaços, que variam sem significar outra fonte", () => {
  assert.equal(familyMatchesFile("blankfixture", BYTES).ok, true);
  assert.equal(familyMatchesFile("Blank Fixture", BYTES).ok, true);
});

test("bytes que não são fonte não derrubam o parser nem viram falso positivo de nome", () => {
  assert.deepEqual(readFamilyNames(Buffer.from("nao sou uma fonte")), []);
  // Sem nome legível a conferência é permissiva de propósito: recusar aqui barraria face válida.
  assert.equal(familyMatchesFile("QualquerCoisa", Buffer.from("xx")).ok, true);
});

test("uma coleção (ttcf) é recusada — as faces têm que ser separadas antes de registrar", () => {
  const ttc = Buffer.concat([Buffer.from("ttcf"), Buffer.alloc(64)]);
  assert.deepEqual(readFamilyNames(ttc), []);
});

test("lê peso e itálico da tabela OS/2 do arquivo real, para 'importar fonte' não exigir isso à mão", () => {
  assert.deepEqual(readOs2WeightAndItalic(BYTES), { weight: 400, italic: false });
});

test("OS/2 ausente ou curta demais devolve null/false em vez de derrubar o parser", () => {
  assert.deepEqual(readOs2WeightAndItalic(Buffer.from("nao sou uma fonte")), { weight: null, italic: false });
  assert.deepEqual(readOs2WeightAndItalic(Buffer.alloc(8)), { weight: null, italic: false });
});
