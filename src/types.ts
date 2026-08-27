/**
 * The document model.
 *
 * Every field here exists because the Figma importer needed it. Three of them —
 * `clip`, `ring` and `filter` — were added after a fidelity diff showed the
 * render was wrong without them, which is precisely the class of mistake this
 * file is meant to make visible.
 */

export type ElType =
  | "rect" | "ellipse" | "triangle" | "star" | "line"
  | "text" | "image" | "icon" | "draw";

export interface Shadow {
  x: number;
  y: number;
  blur: number;
  spread?: number;
  color: string;
}

export interface Gradient {
  type: "linear" | "radial";
  /** CSS convention: 0deg points up, growing clockwise. */
  angle?: number;
  stops: Array<[string, number]>;
}

/** Visible sub-rectangle, in page coordinates — mirrors Figma's clipsContent. */
export interface Clip {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface El {
  id: string;
  type: ElType;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  opacity: number;
  locked: boolean;
  hidden: boolean;
  /** Elements sharing the same group id move/select together; absent means ungrouped. */
  group?: string;

  /** CSS colour, or a CSS gradient string when `grad` is set. */
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius: number;

  /** Structured gradient, needed because canvas export cannot read CSS strings. */
  grad?: Gradient;
  /** Paint only a border band this wide, leaving the middle transparent. */
  ring?: number;
  shadow?: Shadow;
  blur?: number;
  /** CSS filter chain, e.g. Figma's image grading. */
  filter?: string;
  clip?: Clip;

  // text
  text?: string;
  font?: string;
  size?: number;
  weight?: number;
  italic?: boolean;
  underline?: boolean;
  align?: string;
  /** Elements sharing the same centerGroup move together as one block, vertically centered in the page. */
  centerGroup?: string;
  /** Line height as a multiple of font size. */
  lh?: number;
  ls?: number;

  // image — a data URI, or "@key" pointing into Doc.assets
  src?: string;

  // icon
  path?: string;
  viewBox?: string;

  // draw — points normalised to 0..1 of the element box
  pts?: Array<[number, number]>;

  [k: string]: unknown;
}

export interface Page {
  id: string;
  w: number;
  h: number;
  bg: string;
  els: El[];
}

export interface Doc {
  name: string;
  pages: Page[];
  active: number;
  /** Images stored once and referenced by "@key", so a photo used on several
   *  pages is not duplicated into the file. */
  assets?: Record<string, string>;
  /** Identifies the built-in design; a saved copy of an older one is discarded. */
  seedId?: string;
}
