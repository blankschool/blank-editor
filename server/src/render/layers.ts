import type { RenderTweetInput } from "./renderTweet.ts";

export interface LayerValue {
  text?: string;
  image_url?: string;
  hide?: boolean;
}

export type Layers = Record<string, LayerValue>;

class LayerValidationError extends Error {}

function requireText(layers: Layers, name: string): string {
  const value = layers[name]?.text;
  if (!value) throw new LayerValidationError(`missing required layer "${name}" (expected { text: string })`);
  return value;
}

/**
 * Maps the legacy-compatible `layers` request shape (named layers with `text` / `image_url` / `hide`,
 * matching the BlankCanvas API contract) onto the concrete input the "tweet" template renderer needs.
 */
export function mapLayersToTweetInput(layers: Layers): RenderTweetInput {
  const avatarUrl = layers.avatar?.image_url;
  if (!avatarUrl) throw new LayerValidationError('missing required layer "avatar" (expected { image_url: string })');

  const displayName = requireText(layers, "displayName");
  const handle = requireText(layers, "handle");
  const tweetText = requireText(layers, "tweetText");

  const verified = !(layers.verifiedBadge?.hide ?? false);

  const mediaLayer = layers.media;
  const mediaUrl = mediaLayer && !mediaLayer.hide ? mediaLayer.image_url : undefined;

  return { avatarUrl, displayName, handle, tweetText, verified, mediaUrl };
}

export { LayerValidationError };
