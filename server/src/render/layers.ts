export interface LayerValue {
  text?: string;
  image_url?: string;
  hide?: boolean;
}

export type Layers = Record<string, LayerValue>;

export interface ParsedLayers {
  texts: Record<string, string>;
  images: Record<string, string>;
  hidden: Set<string>;
}

/**
 * Splits the request's named `layers` (the legacy-compatible shape: `text` / `image_url` / `hide`
 * per layer) into the maps the renderer needs. There's no fixed set of required layer names here
 * — a template document already has default content for every element it declares; a layer only
 * needs to appear in the request when the caller wants to override or hide it.
 */
export function parseLayers(layers: Layers): ParsedLayers {
  const texts: Record<string, string> = {};
  const images: Record<string, string> = {};
  const hidden = new Set<string>();

  for (const [name, value] of Object.entries(layers)) {
    if (value.text !== undefined) texts[name] = value.text;
    if (value.image_url !== undefined) images[name] = value.image_url;
    if (value.hide) hidden.add(name);
  }

  return { texts, images, hidden };
}
