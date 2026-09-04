import sharp from "sharp";
import { fetchImage } from "./render/imageSource.ts";

export interface MediaAssetRequest {
  strategy: "stock" | "ai";
  query?: string;
  prompt?: string;
  aspectRatio?: string;
}

export interface AcquiredMedia {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg";
  extension: "png" | "jpg";
  width: number;
  height: number;
  provider: "pexels" | "openai";
  externalId: string | null;
  author: string | null;
  attributionUrl: string | null;
  licenseUrl: string | null;
  prompt: string | null;
  model: string | null;
}

export interface MediaAcquisitionService {
  acquire(request: MediaAssetRequest): Promise<AcquiredMedia>;
}

export interface MediaAcquisitionConfig {
  pexelsApiKey?: string;
  openAiApiKey?: string;
  openAiImageModel?: string;
}

type JsonFetch = (url: string, init?: RequestInit) => Promise<Response>;

function orientation(aspectRatio?: string): "portrait" | "landscape" | "square" {
  if (!aspectRatio) return "portrait";
  const [w, h] = aspectRatio.split(":").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return "portrait";
  if (w === h) return "square";
  return w > h ? "landscape" : "portrait";
}

function openAiSize(aspectRatio?: string): string {
  const shape = orientation(aspectRatio);
  if (shape === "square") return "1024x1024";
  return shape === "landscape" ? "1536x1024" : "1024x1536";
}

async function normalizeImage(bytes: Buffer, format: "png" | "jpg"): Promise<{
  bytes: Buffer; width: number; height: number; contentType: "image/png" | "image/jpeg"; extension: "png" | "jpg";
}> {
  const image = sharp(bytes, { limitInputPixels: 40_000_000 }).rotate();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error("media provider returned an invalid image");
  if (metadata.width < 320 || metadata.height < 320) throw new Error("media provider returned an image smaller than 320px");
  const pipeline = image.resize({ width: 3840, height: 3840, fit: "inside", withoutEnlargement: true });
  const output = format === "png" ? await pipeline.png().toBuffer() : await pipeline.jpeg({ quality: 92 }).toBuffer();
  const normalized = await sharp(output).metadata();
  return {
    bytes: output,
    width: normalized.width!,
    height: normalized.height!,
    contentType: format === "png" ? "image/png" : "image/jpeg",
    extension: format,
  };
}

export function createMediaAcquisitionService(
  config: MediaAcquisitionConfig,
  deps: { fetchJson?: JsonFetch; fetchImageBytes?: (url: string) => Promise<Buffer> } = {},
): MediaAcquisitionService {
  const fetchJson = deps.fetchJson ?? fetch;
  const fetchImageBytes = deps.fetchImageBytes ?? fetchImage;

  return {
    async acquire(request) {
      if (request.strategy === "stock") {
        if (!config.pexelsApiKey) throw new Error("stock images are not configured (PEXELS_API_KEY)");
        const query = request.query?.trim() || request.prompt?.trim();
        if (!query) throw new Error("stock media requires query");
        const url = new URL("https://api.pexels.com/v1/search");
        url.searchParams.set("query", query);
        url.searchParams.set("orientation", orientation(request.aspectRatio));
        url.searchParams.set("size", "large");
        url.searchParams.set("locale", "pt-BR");
        url.searchParams.set("per_page", "1");
        const response = await fetchJson(url.toString(), {
          headers: { Authorization: config.pexelsApiKey },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Pexels search failed: ${response.status}`);
        const body = await response.json() as {
          photos?: Array<{
            id: number; photographer?: string; photographer_url?: string; url?: string;
            src?: { original?: string; large2x?: string; portrait?: string; landscape?: string };
          }>;
        };
        const photo = body.photos?.[0];
        if (!photo) throw new Error(`Pexels found no photos for: ${query}`);
        const shape = orientation(request.aspectRatio);
        const source = shape === "portrait" ? photo.src?.portrait : shape === "landscape" ? photo.src?.landscape : photo.src?.large2x;
        const sourceUrl = source ?? photo.src?.large2x ?? photo.src?.original;
        if (!sourceUrl) throw new Error("Pexels result did not include an image URL");
        const normalized = await normalizeImage(await fetchImageBytes(sourceUrl), "jpg");
        return {
          ...normalized,
          provider: "pexels",
          externalId: String(photo.id),
          author: photo.photographer ?? null,
          attributionUrl: photo.url ?? photo.photographer_url ?? null,
          licenseUrl: "https://www.pexels.com/license/",
          prompt: query,
          model: null,
        };
      }

      if (!config.openAiApiKey) throw new Error("AI images are not configured (OPENAI_API_KEY)");
      const prompt = request.prompt?.trim() || request.query?.trim();
      if (!prompt) throw new Error("AI media requires prompt");
      const model = config.openAiImageModel ?? "gpt-image-2";
      const response = await fetchJson("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openAiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, prompt, size: openAiSize(request.aspectRatio), quality: "medium" }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`OpenAI image generation failed: ${response.status} ${await response.text()}`);
      const body = await response.json() as { data?: Array<{ b64_json?: string; revised_prompt?: string }> };
      const encoded = body.data?.[0]?.b64_json;
      if (!encoded) throw new Error("OpenAI image generation returned no image");
      const normalized = await normalizeImage(Buffer.from(encoded, "base64"), "png");
      return {
        ...normalized,
        provider: "openai",
        externalId: null,
        author: null,
        attributionUrl: null,
        licenseUrl: null,
        prompt: body.data?.[0]?.revised_prompt ?? prompt,
        model,
      };
    },
  };
}

