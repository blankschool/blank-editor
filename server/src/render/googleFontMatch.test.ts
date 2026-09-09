import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoogleFontMatcher, CANDIDATOS_GOOGLE_FONTS } from "./googleFontMatch.ts";

const pistas = [{ chave: "DMSans-Bold", bbox: { x: 10, y: 20, w: 300, h: 40 } }];

test("sem OPENAI_API_KEY, devolve vazio sem chamar a rede", async () => {
  let chamou = false;
  const matcher = createGoogleFontMatcher({}, { fetchJson: async () => { chamou = true; return new Response("{}"); } });
  const resultado = await matcher.match(Buffer.from("png"), pistas);
  assert.equal(resultado.size, 0);
  assert.equal(chamou, false);
});

test("resposta com família da lista curada é aceita e o peso arredonda para o mais próximo válido", async () => {
  const matcher = createGoogleFontMatcher({ openAiApiKey: "secret" }, {
    fetchJson: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ "DMSans-Bold": { family: "Montserrat", weight: 680 } }) } }],
    }), { status: 200 }),
  });
  const resultado = await matcher.match(Buffer.from("png"), pistas);
  assert.deepEqual(resultado.get("DMSans-Bold"), { family: "Montserrat", weight: 700 });
});

test("família fora da lista curada é descartada — nunca baixamos um nome que a IA inventou", async () => {
  const matcher = createGoogleFontMatcher({ openAiApiKey: "secret" }, {
    fetchJson: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ "DMSans-Bold": { family: "Fonte Que Nao Existe", weight: 700 } }) } }],
    }), { status: 200 }),
  });
  const resultado = await matcher.match(Buffer.from("png"), pistas);
  assert.equal(resultado.size, 0);
});

test("erro de rede (timeout, DNS) devolve vazio em vez de lançar", async () => {
  const matcher = createGoogleFontMatcher({ openAiApiKey: "secret" }, {
    fetchJson: async () => { throw new Error("network down"); },
  });
  const resultado = await matcher.match(Buffer.from("png"), pistas);
  assert.equal(resultado.size, 0);
});

test("resposta HTTP não-ok devolve vazio", async () => {
  const matcher = createGoogleFontMatcher({ openAiApiKey: "secret" }, {
    fetchJson: async () => new Response("erro", { status: 500 }),
  });
  const resultado = await matcher.match(Buffer.from("png"), pistas);
  assert.equal(resultado.size, 0);
});

test("JSON malformado no content devolve vazio em vez de lançar", async () => {
  const matcher = createGoogleFontMatcher({ openAiApiKey: "secret" }, {
    fetchJson: async () => new Response(JSON.stringify({
      choices: [{ message: { content: "isto não é JSON" } }],
    }), { status: 200 }),
  });
  const resultado = await matcher.match(Buffer.from("png"), pistas);
  assert.equal(resultado.size, 0);
});

test("sem pistas, nem chama a rede", async () => {
  let chamou = false;
  const matcher = createGoogleFontMatcher({ openAiApiKey: "secret" }, { fetchJson: async () => { chamou = true; return new Response("{}"); } });
  const resultado = await matcher.match(Buffer.from("png"), []);
  assert.equal(resultado.size, 0);
  assert.equal(chamou, false);
});

test("a lista curada não tem nomes duplicados", () => {
  assert.equal(new Set(CANDIDATOS_GOOGLE_FONTS).size, CANDIDATOS_GOOGLE_FONTS.length);
});
