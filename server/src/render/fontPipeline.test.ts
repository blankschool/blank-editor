import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { renderTemplatePng } from "./renderTweet.ts";
import { listUsedFamilies, resolveFaces } from "./resolveFonts.ts";
import { FIXTURE_ADVANCE_EM, FIXTURE_FAMILY, FIXTURE_SHA256, fixtureDocFont } from "./__fixtures__/fixtureFont.ts";

const noLayers = { texts: {}, images: {}, hidden: new Set<string>() };

function doc(over: Record<string, unknown> = {}, elOver: Record<string, unknown> = {}) {
  return {
    active: 0,
    fonts: [fixtureDocFont()],
    pages: [{
      w: 400, h: 120, bg: "#FFFFFF",
      els: [{ type: "text", name: "t", x: 20, y: 20, w: 360, h: 60,
              text: "ABCD", size: 40, font: FIXTURE_FAMILY, fill: "#000000", ...elOver }],
    }],
    ...over,
  };
}

/** Largura da tinta preta — é o que prova QUAL fonte desenhou, não só que algo desenhou. */
async function larguraDaTinta(png: Buffer) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = 1e9, x1 = -1;
  for (let i = 0, p = 0; i < data.length; i += info.channels, p++) {
    if (data[i] > 200) continue;
    const x = p % info.width;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
  }
  return x1 < 0 ? 0 : x1 - x0 + 1;
}

test("a fonte declarada pelo documento é a que desenha — largura bate com a métrica escolhida da fixture", async () => {
  const png = await renderTemplatePng(doc(), noLayers);
  // 4 glifos de 0.5 em a 40px = 4 retângulos; o primeiro começa 50/1000 em dentro do avanço e
  // o último termina 50/1000 antes do fim, então a tinta mede 4*20 - 2*2 = 76px.
  const esperado = 4 * FIXTURE_ADVANCE_EM * 40 - 2 * (50 / 1000) * 40;
  const medido = await larguraDaTinta(png);
  assert.ok(Math.abs(medido - esperado) <= 2, `largura ${medido}px, esperado ~${esperado}px`);
});

test("gate honesto: uma família que o documento NÃO declara não cai numa fonte parecida — o render recusa", async () => {
  // O teste ingênuo (família real vs família fantasma) daria falso negativo, porque o
  // rasterizador pode usar a primeira fonte carregada como fallback e as duas medirem igual.
  // Aqui a recusa é observável antes de qualquer pixel existir.
  await assert.rejects(
    () => renderTemplatePng(doc({}, { font: "FamiliaNaoDeclarada" }), noLayers),
    /FamiliaNaoDeclarada.*não declara/s,
  );
});

test("um elemento sem `font` exige a família default, não desenha em branco calado", async () => {
  const d = doc({ fonts: [] }, { font: undefined });
  await assert.rejects(() => renderTemplatePng(d, noLayers), /"Inter".*não declara/s);
});

test("listUsedFamilies conta o default para o elemento sem fonte e ignora camada escondida", () => {
  const page = { els: [
    { type: "text", font: "A" },
    { type: "text" },
    { type: "text", font: "Escondida", hidden: true },
    { type: "image", font: "NaoConta" },
  ] };
  assert.deepEqual(listUsedFamilies(page).sort(), ["A", "Inter"]);
});

test("resolveFaces devolve só as faces das famílias usadas — um carrossel não carrega a fonte de outra página", () => {
  const usada = { family: "Usada", weight: 400, sha256: "a", src: "/x.ttf" };
  const outra = { family: "Outra", weight: 400, sha256: "b", src: "/y.ttf" };
  assert.deepEqual(resolveFaces([usada, outra], ["Usada"]), [usada]);
});

test("família declarada duas vezes no mesmo peso com bytes diferentes é ambígua — recusa em vez de sortear", () => {
  const faces = [
    { family: "F", weight: 400, sha256: "aaaaaaaaaaaaaa", src: "/1.ttf" },
    { family: "F", weight: 400, sha256: "bbbbbbbbbbbbbb", src: "/2.ttf" },
  ];
  assert.throws(() => resolveFaces(faces, ["F"]), /Ambíguo/);
});

test("mesma família em pesos diferentes é normal, não ambiguidade", () => {
  const faces = [
    { family: "F", weight: 300, sha256: "a", src: "/1.ttf" },
    { family: "F", weight: 700, sha256: "b", src: "/2.ttf" },
  ];
  assert.equal(resolveFaces(faces, ["F"]).length, 2);
});

test("sha256 que não confere com os bytes derruba o render em vez de desenhar com a fonte errada", async () => {
  const d = doc({ fonts: [{ ...fixtureDocFont(), sha256: "0".repeat(64) }] });
  await assert.rejects(() => renderTemplatePng(d, noLayers), /não confere/);
});

test("a fixture tem o sha256 que os testes declaram (pega troca acidental do arquivo)", () => {
  assert.match(FIXTURE_SHA256, /^[0-9a-f]{64}$/);
});

test("subset de PDF: pedir uma letra que a face não tem para o render e nomeia a camada e o caractere", async () => {
  // NYTFranklin-Light saiu do PDF com 16 glifos: " ?acdegilmnoruvó". Um "b" não existe nela.
  const d = {
    active: 0,
    fonts: [{ family: "Subset", weight: 300, sha256: "x", ttf: "/nao/importa.ttf", woff2: "",
              glyphs: " ?acdegilmnoruvó" }],
    pages: [{ w: 200, h: 80, bg: "#FFF", els: [
      { type: "text", name: "manchete", x: 0, y: 0, w: 200, h: 40, text: "bola", size: 20, font: "Subset", weight: 300 },
    ] }],
  };
  await assert.rejects(() => renderTemplatePng(d, noLayers), (e: Error) => {
    assert.match(e.message, /"manchete"/);
    assert.match(e.message, /"b" \(U\+0062\)/);
    assert.match(e.message, /subset/);
    return true;
  });
});

test("a verificação de cobertura olha o texto do OVERRIDE, não o que o documento guardou", async () => {
  const d = {
    active: 0,
    fonts: [{ family: "Subset", weight: 400, sha256: "x", ttf: "/nao/importa.ttf", woff2: "", glyphs: "abc " }],
    pages: [{ w: 200, h: 80, bg: "#FFF", els: [
      { type: "text", name: "t", x: 0, y: 0, w: 200, h: 40, text: "abc", size: 20, font: "Subset" },
    ] }],
  };
  // O documento sozinho é coberto; o texto que a API manda desenhar não é.
  await assert.rejects(
    () => renderTemplatePng(d, { texts: { t: "abz" }, images: {}, hidden: new Set() }),
    /"z" \(U\+007A\)/,
  );
});

test("fonte completa (sem `glyphs` declarado) não é verificada — só subsets têm o que provar", async () => {
  const png = await renderTemplatePng(doc({}, { text: "Zx?!" }), noLayers);
  assert.ok(png.length > 0);
});

test("fonte embutida como data URI funciona — é o que faz um .json exportado abrir em qualquer instalação", async () => {
  const { readFileSync } = await import("node:fs");
  const { FIXTURE_FONT_PATH, FIXTURE_SHA256, FIXTURE_FAMILY: fam } = await import("./__fixtures__/fixtureFont.ts");
  const dataUri = `data:font/ttf;base64,${readFileSync(FIXTURE_FONT_PATH).toString("base64")}`;
  const d = doc({ fonts: [{ family: fam, weight: 400, sha256: FIXTURE_SHA256, ttf: dataUri, woff2: "" }] });
  const png = await renderTemplatePng(d, noLayers);
  const largura = await larguraDaTinta(png);
  assert.ok(largura > 60, `desenhou ${largura}px — a fonte embutida não foi carregada`);
});

test("canário de preflight aprova quando a fonte realmente desenha", async () => {
  const { canarioDeFonte } = await import("./preflight.ts");
  const { FIXTURE_FAMILY: fam, FIXTURE_SHA256, FIXTURE_FONT_PATH } = await import("./__fixtures__/fixtureFont.ts");
  const r = await canarioDeFonte([{ family: fam, weight: 400, sha256: FIXTURE_SHA256, src: FIXTURE_FONT_PATH }], fam);
  assert.equal(r.ok, true, r.detalhe);
});

test("canário reprova com registry vazio — é o caso 'deploy verde, arte em branco'", async () => {
  const { canarioDeFonte } = await import("./preflight.ts");
  const r = await canarioDeFonte([], "Inter");
  assert.equal(r.ok, false);
  assert.match(r.detalhe, /nenhuma face registrada/);
});

test("achado medido: o rasterizador NÃO recusa família que não casa — desenha com a fonte carregada", async () => {
  const { canarioDeFonte } = await import("./preflight.ts");
  const { FIXTURE_SHA256, FIXTURE_FONT_PATH } = await import("./__fixtures__/fixtureFont.ts");
  // Pede "Inter" tendo carregado só um arquivo que por dentro se chama BlankFixture. Era de
  // esperar que não desenhasse; ele desenha, silenciosamente, com o que tem. Por isso o canário
  // não basta como defesa contra nome trocado — quem defende é a conferência contra os BYTES,
  // no registro (fonts/sfntNames.ts). Este teste existe para travar esse comportamento: se um
  // dia o rasterizador passar a recusar, queremos saber.
  const r = await canarioDeFonte([{ family: "Inter", weight: 400, sha256: FIXTURE_SHA256, src: FIXTURE_FONT_PATH }], "Inter");
  assert.equal(r.ok, true, "se isto falhar, o rasterizador mudou de comportamento — reveja preflight.ts");
});

test("família não declarada no documento é resolvida pelo registry do dono — é o que faz o seed valer", async () => {
  const { FIXTURE_SHA256, FIXTURE_FONT_PATH, FIXTURE_FAMILY: fam } = await import("./__fixtures__/fixtureFont.ts");
  // Documento no formato antigo: usa a fonte, não declara nada. Antes do registry, erro.
  const d = { active: 0, pages: [{ w: 300, h: 100, bg: "#FFF", els: [
    { type: "text", name: "t", x: 10, y: 10, w: 280, h: 40, text: "ABCD", size: 30, font: fam, fill: "#000" },
  ] }] };
  await assert.rejects(() => renderTemplatePng(d, noLayers), /não declara/);
  const png = await renderTemplatePng(d, noLayers, undefined,
    [{ family: fam, weight: 400, sha256: FIXTURE_SHA256, src: FIXTURE_FONT_PATH }]);
  assert.ok(await larguraDaTinta(png) > 40);
});

test("o que o documento declara tem precedência sobre o registry — um design antigo não muda porque o dono registrou outra versão", async () => {
  const { FIXTURE_SHA256, FIXTURE_FONT_PATH, FIXTURE_FAMILY: fam } = await import("./__fixtures__/fixtureFont.ts");
  const d = doc();   // já declara a fixture em Doc.fonts
  const impostor = { family: fam, weight: 400, sha256: "0".repeat(64), src: "/nao/existe.ttf" };
  // Se o registry vencesse, o sha não conferiria e o render explodiria. Ele não vence.
  const png = await renderTemplatePng(d, noLayers, undefined, [impostor]);
  assert.ok(png.length > 0);
});
