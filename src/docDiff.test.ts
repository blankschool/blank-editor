import { test } from "node:test";
import assert from "node:assert/strict";
import { diffDocs, docsAreEqual } from "./docDiff.ts";
import type { Doc, El } from "./types.ts";

function el(overrides: Partial<El> = {}): El {
  return {
    id: "el-1", type: "text", name: "titulo", x: 0, y: 0, w: 100, h: 40,
    rot: 0, opacity: 1, locked: false, hidden: false, fill: "#000", stroke: "", strokeWidth: 0, radius: 0,
    ...overrides,
  };
}

function doc(overrides: Partial<Doc> = {}): Doc {
  return {
    name: "Design", active: 0,
    pages: [{ id: "p1", w: 1080, h: 1350, bg: "#fff", els: [el()] }],
    ...overrides,
  };
}

test("two identical documents have no diff", () => {
  const a = doc();
  const b = doc();
  assert.equal(docsAreEqual(a, b), true);
  assert.deepEqual(diffDocs(a, b), { fields: {}, pagesAdded: [], pagesRemoved: [], pagesChanged: [] });
});

test("a top-level field change (name) is reported, pages untouched", () => {
  const a = doc({ name: "Antigo" });
  const b = doc({ name: "Novo" });
  const diff = diffDocs(a, b);
  assert.deepEqual(diff.fields, { name: { from: "Antigo", to: "Novo" } });
  assert.equal(diff.pagesChanged.length, 0);
});

test("a page matched by id with a changed field (bg) is reported under pagesChanged, not as add+remove", () => {
  const a = doc({ pages: [{ id: "p1", w: 1080, h: 1350, bg: "#000", els: [] }] });
  const b = doc({ pages: [{ id: "p1", w: 1080, h: 1350, bg: "#fff", els: [] }] });
  const diff = diffDocs(a, b);
  assert.equal(diff.pagesAdded.length, 0);
  assert.equal(diff.pagesRemoved.length, 0);
  assert.deepEqual(diff.pagesChanged, [{
    pageId: "p1", fields: { bg: { from: "#000", to: "#fff" } },
    elementsAdded: [], elementsRemoved: [], elementsChanged: [],
  }]);
});

test("a page present only in one side is added/removed, not diffed field by field", () => {
  const a = doc({ pages: [{ id: "p1", w: 1080, h: 1350, bg: "#fff", els: [] }] });
  const b = doc({
    pages: [
      { id: "p1", w: 1080, h: 1350, bg: "#fff", els: [] },
      { id: "p2", w: 1080, h: 1350, bg: "#000", els: [] },
    ],
  });
  const diff = diffDocs(a, b);
  assert.equal(diff.pagesAdded.length, 1);
  assert.equal(diff.pagesAdded[0].id, "p2");
  assert.equal(diff.pagesRemoved.length, 0);
  assert.equal(diff.pagesChanged.length, 0);
});

test("elements are matched by id: moving an element in the array is not a change, editing its text is", () => {
  const elA = el({ id: "a", text: "Oi" } as Partial<El>);
  const elB = el({ id: "b", name: "sub" });
  const a = doc({ pages: [{ id: "p1", w: 1080, h: 1350, bg: "#fff", els: [elA, elB] }] });
  const b = doc({
    pages: [{
      id: "p1", w: 1080, h: 1350, bg: "#fff",
      // ordem invertida na lista + texto do elemento "a" mudou
      els: [elB, { ...elA, text: "Tchau" } as El],
    }],
  });
  const diff = diffDocs(a, b);
  assert.equal(diff.pagesChanged.length, 1);
  const [pageDiff] = diff.pagesChanged;
  assert.deepEqual(pageDiff.elementsAdded, []);
  assert.deepEqual(pageDiff.elementsRemoved, []);
  assert.deepEqual(pageDiff.elementsChanged, [{ elementId: "a", fields: { text: { from: "Oi", to: "Tchau" } } }]);
});

test("an element added or removed from a page is reported, not treated as a field change", () => {
  const a = doc({ pages: [{ id: "p1", w: 1080, h: 1350, bg: "#fff", els: [el({ id: "a" })] }] });
  const b = doc({ pages: [{ id: "p1", w: 1080, h: 1350, bg: "#fff", els: [el({ id: "a" }), el({ id: "b" })] }] });
  const diff = diffDocs(a, b);
  assert.equal(diff.pagesChanged.length, 1);
  assert.equal(diff.pagesChanged[0].elementsAdded.length, 1);
  assert.equal(diff.pagesChanged[0].elementsAdded[0].id, "b");
  assert.equal(diff.pagesChanged[0].elementsRemoved.length, 0);
  assert.equal(diff.pagesChanged[0].elementsChanged.length, 0);
});
