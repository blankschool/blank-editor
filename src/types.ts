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

/** One styled run within a rich-text `El.runs` sequence. Every field is an override of the
 *  parent element's own value — absent means "use the element's weight/italic/etc." — so a
 *  plain run in an otherwise-styled headline doesn't need to repeat the base style. */
export interface TextRun {
  text: string;
  weight?: number;
  italic?: boolean;
  underline?: boolean;
  fill?: string;
  font?: string;
}

export interface El {
  autoFit?: boolean;
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
  /** Mixed styling within one text box (a bold word mid-headline, a colored phrase…). When
   *  present, renderers draw `runs` end-to-end instead of the plain `text` string — `text`
   *  stays populated too (the concatenation of every run, in order) so anything that only
   *  reads plain text (search, the JSON export, an older reader) keeps working. Every run
   *  shares the element's `size` — mixed font SIZE within one box isn't supported, only
   *  weight/style/color/underline/font per run, which covers what a "bold word" actually
   *  needs without the much harder problem of re-flowing wrapped lines whose own height varies
   *  word to word. */
  runs?: TextRun[];

  // image — a data URI, or "@key" pointing into Doc.assets
  src?: string;
  /** Recorte independente da moldura — um retângulo 0..1 relativo à imagem ORIGINAL (não ao
   *  box do elemento), igual ao crop de Canva/Figma: mover a foto dentro do quadro é só mudar
   *  `imgX`/`imgY`; redimensionar a moldura não distorce o enquadramento porque o crop já
   *  registrado não muda. Ausente = comportamento anterior ("cover" automático, centralizado,
   *  recalculado a cada render a partir do tamanho atual da moldura). */
  imgX?: number;
  imgY?: number;
  imgW?: number;
  imgH?: number;

  // icon
  path?: string;
  viewBox?: string;

  // draw — points normalised to 0..1 of the element box
  pts?: Array<[number, number]>;
  /** draw — an arbitrary filled vector shape (icon, halftone dot, outlined-title glyph…),
   *  as an SVG path `d` string in the SAME 0..1 normalised space as `pts`: renderers scale
   *  the whole path by the element's current w/h (SVG `transform="scale(w,h)"`, canvas
   *  `ctx.scale(w,h)`) rather than rescaling every coordinate in the string, so resizing the
   *  element never needs to touch `d` itself. Independent of `pts` — an element can carry a
   *  filled `fillPath`, a stroked `pts` polyline, or both. */
  fillPath?: string;

  [k: string]: unknown;
}

export interface Page {
  id: string;
  w: number;
  h: number;
  bg: string;
  els: El[];
  /** Skipped by the "present" mode and by multi-page PDF export; still editable directly. */
  hidden?: boolean;
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
  /** Fontes que pertencem a ESTE design, não ao app.
   *
   *  Uma arte importada de um PDF do Canva traz as famílias dela embutidas (AniconSans,
   *  NYTFranklin…). Elas não estão instaladas em lugar nenhum — nem no navegador de quem abre
   *  o design, nem no container que renderiza —, então precisam viajar junto com o documento.
   *  Sem isto, o canvas e o render desenham o mesmo texto com fontes diferentes: as larguras
   *  divergem e a manchete, cujos trechos são posicionados por largura medida, colide. */
  fonts?: DocFont[];
}

/** Uma face de fonte que o design carrega consigo. */
export interface DocFont {
  /** O que os elementos põem em `El.font` — a família, sem o estilo ("NYTFranklin"). */
  family: string;
  /** Peso CSS que esta face atende (300, 600, 700…), casado com `El.weight`. */
  weight: number;
  /** sha256 dos bytes do SFNT. É a IDENTIDADE da face, não só um checksum: o cache do renderer
   *  é indexado por ele, e é o que garante que um design antigo não mude de aparência porque
   *  alguém subiu bytes diferentes na mesma URL. */
  sha256: string;
  /** URL pública do .woff2, para o @font-face do navegador. */
  woff2: string;
  /** URL do .ttf/.otf, para o rasterizador do servidor carregar o arquivo. */
  ttf: string;
  /** Só os glifos que esta face traz — o subset vem do PDF e não cobre o alfabeto inteiro.
   *  É o que permite avisar "essa letra não existe nesta fonte" em vez de desenhar nada. */
  glyphs?: string;
}
