import sharp from "sharp";
import { buildEditableTweetSvg } from "./editableTweetTemplate.ts";
import { buildTweetSvg, type TweetInput } from "./tweetTemplate.ts";
import { fetchImage } from "./imageSource.ts";

export interface RenderTweetInput extends TweetInput {
  avatarUrl: string;
}

export interface ComposeTweetInput extends TweetInput {
  avatarBuffer: Buffer;
}

function maskSvg(width: number, height: number, shape: string): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shape}</svg>`);
}

function circleMask(size: number): Buffer {
  const r = size / 2;
  return maskSvg(size, size, `<circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/>`);
}

function maskToFit(raw: Buffer, box: { width: number; height: number }, mask: Buffer): Promise<Buffer> {
  return sharp(raw)
    .resize(box.width, box.height, { fit: "cover" })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

/**
 * Composes the tweet-screenshot PNG from already-fetched image bytes. Pure aside from the
 * sharp calls — no network I/O — so it's the seam covered by tests; `renderTweetPng` below
 * is the thin network-fetching wrapper around it.
 */
export async function composeTweetPng(input: ComposeTweetInput): Promise<Buffer> {
  const { svg, layout } = buildTweetSvg(input);

  const [base, avatar] = await Promise.all([
    sharp(Buffer.from(svg)).png().toBuffer(),
    maskToFit(input.avatarBuffer, { width: layout.avatarBox.size, height: layout.avatarBox.size }, circleMask(layout.avatarBox.size)),
  ]);

  return sharp(base)
    .composite([{ input: avatar, left: layout.avatarBox.x, top: layout.avatarBox.y }])
    .png()
    .toBuffer();
}

export async function composeEditableTweetPng(input: ComposeTweetInput, document: unknown): Promise<Buffer> {
  const avatarPng = await sharp(input.avatarBuffer).png().toBuffer();
  const avatarDataUrl = `data:image/png;base64,${avatarPng.toString("base64")}`;
  const svg = buildEditableTweetSvg(document, input, avatarDataUrl);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Fetches the avatar over HTTP(S) — SSRF-guarded — then composes the PNG. */
export async function renderTweetPng(input: RenderTweetInput, document?: unknown): Promise<Buffer> {
  const avatarBuffer = await fetchImage(input.avatarUrl);
  if (document) return composeEditableTweetPng({ ...input, avatarBuffer }, document);
  return composeTweetPng({ ...input, avatarBuffer });
}
