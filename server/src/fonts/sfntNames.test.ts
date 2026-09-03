import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFamilyNames, familyMatchesFile } from "./sfntNames.ts";
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
