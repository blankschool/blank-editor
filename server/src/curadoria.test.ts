import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizarTema, tokensDoTema, SCORE_MINIMO } from "./curadoria.ts";

test("normalizarTema tira acento, caixa e espaço das pontas", () => {
  assert.equal(normalizarTema("  Eleições 2026 "), "eleicoes 2026");
  assert.equal(normalizarTema("Finanças"), "financas");
  assert.equal(normalizarTema("SÃO PAULO"), "sao paulo");
});

test("normalizarTema deixa texto sem acento intacto", () => {
  assert.equal(normalizarTema("banco master"), "banco master");
});

test("tokensDoTema descarta stopwords e palavras curtas", () => {
  // "de" e "para" são stopwords; "com" também. Sobram só as palavras que carregam sentido.
  assert.deepEqual(tokensDoTema("finanças para iniciantes"), ["financas", "iniciantes"]);
  assert.deepEqual(tokensDoTema("o STF e a crise"), ["crise"]);
});

test("tokensDoTema normaliza antes de tokenizar", () => {
  assert.deepEqual(tokensDoTema("Eleições Municipais"), ["eleicoes", "municipais"]);
});

test("tokensDoTema quebra em qualquer separador não alfanumérico", () => {
  assert.deepEqual(tokensDoTema("marketing/vendas, b2b"), ["marketing", "vendas"]);
});

test("tokensDoTema devolve lista vazia pra tema só de stopwords", () => {
  assert.deepEqual(tokensDoTema("de para com"), []);
});

test("o corte de score exige mais que um token solto batendo", () => {
  // O score por token é proporcional: 60 * (tokens que batem / total de tokens).
  // Este teste trava a regra que evita o falso positivo medido ("rotina matinal de skincare"
  // casando com o tópico "rotina de alimentação" por causa da palavra "rotina").
  const tokens = tokensDoTema("rotina matinal de skincare");
  assert.equal(tokens.length, 3);
  const scoreDeUmTokenSo = Math.round((60 * 1) / tokens.length);
  assert.ok(scoreDeUmTokenSo < SCORE_MINIMO, `1 de ${tokens.length} tokens deveria ficar abaixo do corte`);

  const scoreDeTodos = Math.round((60 * tokens.length) / tokens.length);
  assert.ok(scoreDeTodos >= SCORE_MINIMO, "todos os tokens batendo deveria passar do corte");
});
