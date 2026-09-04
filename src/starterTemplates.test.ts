import { test } from "node:test";
import assert from "node:assert/strict";
import { STARTERS } from "./console/starterTemplates.ts";

test("the automation starter is a reusable one-page card with the n8n layer contract", () => {
  const starter = STARTERS.find((item) => item.id === "automation");
  const document = starter?.build();

  assert.deepEqual({
    label: starter?.label,
    pages: document?.pages.length,
    fields: document?.pages[0].els.filter((element) => element.type === "text").map((element) => element.name),
    image: document?.pages[0].els.find((element) => element.type === "image")?.name,
    cta: document?.pages[0].els.find((element) => element.name === "cta")?.text,
  }, {
    label: "Card para automação",
    pages: 1,
    fields: ["numero", "titulo", "corpo", "cta"],
    image: "imagem",
    cta: "",
  });
});
