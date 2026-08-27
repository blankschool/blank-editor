import sharp, { type OverlayOptions } from "sharp";
import { buildTweetSvg, MEDIA_RADIUS, type Box, type TweetInput } from "./tweetTemplate.ts";
import { fetchImage } from "./imageSource.ts";

export interface RenderTweetInput extends Omit<TweetInput, "hasMedia"> {
  avatarUrl: string;
  mediaUrl?: string;
}

export interface ComposeTweetInput extends Omit<TweetInput, "hasMedia"> {
  avatarBuffer: Buffer;
  mediaBuffer?: Buffer;
}

function circleMask(size: number): Buffer {
  const r = size / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/></svg>`,
  );
}

function roundedRectMask(width: number, height: number, radius: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" fill="#fff"/></svg>`,
  );
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
  const { svg, layout } = buildTweetSvg({ ...input, hasMedia: Boolean(input.mediaBuffer) });

  const [base, avatar, media] = await Promise.all([
    sharp(Buffer.from(svg)).png().toBuffer(),
    maskToFit(input.avatarBuffer, { width: layout.avatarBox.size, height: layout.avatarBox.size }, circleMask(layout.avatarBox.size)),
    input.mediaBuffer && layout.mediaBox
      ? maskToFit(input.mediaBuffer, layout.mediaBox, roundedRectMask(layout.mediaBox.width, layout.mediaBox.height, MEDIA_RADIUS))
      : Promise.resolve(null),
  ]);

  const composites: OverlayOptions[] = [{ input: avatar, left: layout.avatarBox.x, top: layout.avatarBox.y }];
  const mediaBox: Box | null = layout.mediaBox;
  if (media && mediaBox) composites.push({ input: media, left: mediaBox.x, top: mediaBox.y });

  return sharp(base).composite(composites).png().toBuffer();
}

/** Fetches the avatar and (optional) attached photo over HTTP(S) — SSRF-guarded — then composes the PNG. */
export async function renderTweetPng(input: RenderTweetInput): Promise<Buffer> {
  const [avatarBuffer, mediaBuffer] = await Promise.all([
    fetchImage(input.avatarUrl),
    input.mediaUrl ? fetchImage(input.mediaUrl) : Promise.resolve(undefined),
  ]);
  return composeTweetPng({ ...input, avatarBuffer, mediaBuffer });
}
