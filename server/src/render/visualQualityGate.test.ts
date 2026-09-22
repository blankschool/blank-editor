import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPageVisualQuality,
  checkDocumentVisualQuality,
  type JevClient,
  type QualityPage,
} from "./visualQualityGate.ts";

/** Jev falso e determinístico: sabe responder às duas perguntas que este gate faz, sem rede. */
function fakeJev(overrides: { noul?: number; score?: number } = {}): JevClient {
  return {
    async ask(_state, questions) {
      const answers: Record<string, { noul?: number; score?: number }> = {};
      for (const key of Object.keys(questions)) {
        if (key.startsWith("linha_duplicada_")) answers[key] = { noul: overrides.noul ?? 0.9 };
        if (key.startsWith("estouro_")) answers[key] = { score: overrides.score ?? 1.9 };
      }
      return answers;
    },
  };
}

const page = (els: QualityPage["els"]): QualityPage => ({ w: 1080, h: 1350, els });

test("flags two near-overlapping shapes with different rotation as a duplicate/crooked shape", async () => {
  const issues = await checkPageVisualQuality(
    page([
      { id: "a", type: "line", x: 60, y: 819, w: 830, h: 3, rot: 356 },
      { id: "b", type: "line", x: 60, y: 805, w: 830, h: 3, rot: 350 },
    ]),
    fakeJev(),
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "duplicate_crooked_shape");
  assert.deepEqual(issues[0].elementIds.sort(), ["a", "b"]);
  assert.equal(issues[0].probability, 0.9);
});

test("does not flag shapes with no bbox overlap", async () => {
  const issues = await checkPageVisualQuality(
    page([
      { id: "a", type: "line", x: 0, y: 0, w: 100, h: 3, rot: 0 },
      { id: "b", type: "line", x: 900, y: 1300, w: 100, h: 3, rot: 45 },
    ]),
    fakeJev(),
  );
  assert.equal(issues.length, 0);
});

test("does not flag two identical shapes (same position and rotation)", async () => {
  const issues = await checkPageVisualQuality(
    page([
      { id: "a", type: "rect", x: 10, y: 10, w: 50, h: 50, rot: 0 },
      { id: "b", type: "rect", x: 10, y: 10, w: 50, h: 50, rot: 0 },
    ]),
    fakeJev(),
  );
  assert.equal(issues.length, 0);
});

test("flags text whose wrapped height clearly exceeds its box", async () => {
  const issues = await checkPageVisualQuality(
    page([
      {
        id: "titulo",
        type: "text",
        x: 60,
        y: 850,
        w: 960,
        h: 320,
        rot: 0,
        text: "Ozempic e Mounjaro estão esvaziando prateleira de doce, salgadinho e bebida em supermercado americano, segundo estudo que já circula forte lá fora.",
        size: 92,
        lh: 1.1,
      },
    ]),
    fakeJev(),
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "text_overflow");
  assert.equal(issues[0].elementIds[0], "titulo");
});

test("não marca estouro em texto com autoFit — o renderer já encolhe a fonte antes de desenhar (achado real: import de PDF de 51MB, 'Prosa Sertaneja', dava falso positivo aqui)", async () => {
  const issues = await checkPageVisualQuality(
    page([
      {
        id: "titulo",
        type: "text",
        x: 60,
        y: 850,
        w: 960,
        h: 320,
        rot: 0,
        text: "Ozempic e Mounjaro estão esvaziando prateleira de doce, salgadinho e bebida em supermercado americano, segundo estudo que já circula forte lá fora.",
        size: 92,
        lh: 1.1,
        autoFit: true,
      },
    ]),
    fakeJev(),
  );
  assert.equal(issues.length, 0);
});

test("does not flag text that fits comfortably in its box", async () => {
  const issues = await checkPageVisualQuality(
    page([
      { id: "titulo", type: "text", x: 60, y: 850, w: 960, h: 320, rot: 0, text: "Título curto", size: 46, lh: 1.1 },
    ]),
    fakeJev(),
  );
  assert.equal(issues.length, 0);
});

test("skips the Jev call entirely when there are no candidate issues (no network cost)", async () => {
  let called = false;
  const jev: JevClient = {
    async ask() {
      called = true;
      return {};
    },
  };
  const issues = await checkPageVisualQuality(
    page([{ id: "a", type: "rect", x: 0, y: 0, w: 100, h: 100, rot: 0 }]),
    jev,
  );
  assert.equal(issues.length, 0);
  assert.equal(called, false);
});

test("respects the Jev threshold — a low-probability answer is not flagged", async () => {
  const issues = await checkPageVisualQuality(
    page([
      { id: "a", type: "line", x: 60, y: 819, w: 830, h: 3, rot: 356 },
      { id: "b", type: "line", x: 60, y: 805, w: 830, h: 3, rot: 350 },
    ]),
    fakeJev({ noul: 0.2 }),
  );
  assert.equal(issues.length, 0);
});

test("checkDocumentVisualQuality only returns pages that actually have issues", async () => {
  const results = await checkDocumentVisualQuality(
    [
      page([{ id: "clean", type: "rect", x: 0, y: 0, w: 100, h: 100, rot: 0 }]),
      page([
        { id: "a", type: "line", x: 60, y: 819, w: 830, h: 3, rot: 356 },
        { id: "b", type: "line", x: 60, y: 805, w: 830, h: 3, rot: 350 },
      ]),
    ],
    fakeJev(),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].pageIndex, 1);
});
