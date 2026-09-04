import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createMediaAcquisitionService } from "./mediaAcquisition.ts";

async function fixture(width = 640, height = 800): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#3478f6" } }).jpeg().toBuffer();
}

test("stock acquisition searches Pexels, copies bytes and preserves attribution", async () => {
  let requestUrl = "";
  let authorization = "";
  const service = createMediaAcquisitionService({ pexelsApiKey: "secret" }, {
    fetchJson: async (url, init) => {
      requestUrl = url;
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ photos: [{
        id: 42, photographer: "Ada", url: "https://www.pexels.com/photo/42",
        src: { portrait: "https://images.pexels.com/photo.jpg" },
      }] }), { status: 200 });
    },
    fetchImageBytes: async () => fixture(),
  });
  const result = await service.acquire({ strategy: "stock", query: "professora brasileira", aspectRatio: "4:5" });
  assert.match(requestUrl, /orientation=portrait/);
  assert.equal(authorization, "secret");
  assert.equal(result.provider, "pexels");
  assert.equal(result.externalId, "42");
  assert.equal(result.author, "Ada");
  assert.equal(result.width, 640);
  assert.equal(result.height, 800);
});

test("AI acquisition uses the configured OpenAI image model and base64 result", async () => {
  const image = await fixture(1024, 1024);
  let payload: Record<string, unknown> = {};
  const service = createMediaAcquisitionService({ openAiApiKey: "secret", openAiImageModel: "gpt-image-test" }, {
    fetchJson: async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: [{ b64_json: image.toString("base64"), revised_prompt: "revised" }] }), { status: 200 });
    },
  });
  const result = await service.acquire({ strategy: "ai", prompt: "uma sala de aula", aspectRatio: "4:5" });
  assert.deepEqual(payload, {
    model: "gpt-image-test", prompt: "uma sala de aula", size: "1024x1536", quality: "medium",
  });
  assert.equal(result.provider, "openai");
  assert.equal(result.prompt, "revised");
  assert.equal(result.contentType, "image/png");
});

test("a requested provider fails clearly when its credential is missing", async () => {
  const service = createMediaAcquisitionService({});
  await assert.rejects(() => service.acquire({ strategy: "stock", query: "people" }), /PEXELS_API_KEY/);
  await assert.rejects(() => service.acquire({ strategy: "ai", prompt: "people" }), /OPENAI_API_KEY/);
});

