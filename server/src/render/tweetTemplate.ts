import { escapeXml } from "./svg.ts";
import { wrapText } from "./wrapText.ts";

export const TWEET_WIDTH = 566;

const PADDING = 16;
const AVATAR_SIZE = 40;
const NAME_FONT_SIZE = 15;
const HANDLE_FONT_SIZE = 15;
const TEXT_FONT_SIZE = 15;
const LINE_HEIGHT = 20;
const HEADER_TO_TEXT_GAP = 12;
const HEADER_TEXT_X = PADDING + AVATAR_SIZE + 8;

const COLOR_BG = "#000000";
const COLOR_PRIMARY = "rgb(230, 233, 234)";
const COLOR_SECONDARY = "rgb(113, 117, 122)";

const FONT_FAMILY = "'Inter', -apple-system, 'system-ui', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface TweetInput {
  displayName: string;
  handle: string;
  tweetText: string;
}

export interface TweetLayout {
  width: number;
  height: number;
  /** Where the caller should composite the (separately fetched) avatar photo, as a circle. */
  avatarBox: { x: number; y: number; size: number };
}

export interface BuiltTweet {
  svg: string;
  layout: TweetLayout;
}

/** Builds the static text/background layer of the minimal tweet template as SVG. */
export function buildTweetSvg(input: TweetInput): BuiltTweet {
  // The tweet body spans the full content width, not just the header's text column.
  const bodyWidth = TWEET_WIDTH - PADDING * 2;
  const bodyLines = wrapText(input.tweetText, bodyWidth, TEXT_FONT_SIZE);

  const headerBottom = PADDING + AVATAR_SIZE;
  const textTop = headerBottom + HEADER_TO_TEXT_GAP;
  const textHeight = bodyLines.length * LINE_HEIGHT;
  const textBottom = textTop + textHeight;

  const height = textBottom + PADDING;

  const avatarBox = { x: PADDING, y: PADDING, size: AVATAR_SIZE };
  const nameY = PADDING;
  const handleY = PADDING + 20;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${TWEET_WIDTH}" height="${height}" viewBox="0 0 ${TWEET_WIDTH} ${height}">`);
  parts.push(`<rect x="0" y="0" width="${TWEET_WIDTH}" height="${height}" fill="${COLOR_BG}"/>`);
  parts.push(`<style>text { font-family: ${FONT_FAMILY}; }</style>`);

  // Header: display name and handle. Avatar itself is composited later.
  parts.push(
    `<text x="${HEADER_TEXT_X}" y="${nameY + 15}" font-size="${NAME_FONT_SIZE}" font-weight="700" fill="${COLOR_PRIMARY}">${escapeXml(input.displayName)}</text>`,
  );
  parts.push(
    `<text x="${HEADER_TEXT_X}" y="${handleY + 15}" font-size="${HANDLE_FONT_SIZE}" font-weight="400" fill="${COLOR_SECONDARY}">${escapeXml(input.handle)}</text>`,
  );

  // Tweet body, one <tspan> per wrapped line.
  const tspans = bodyLines
    .map(
      (line, i) =>
        `<tspan x="${PADDING}" y="${textTop + i * LINE_HEIGHT + 15}">${line === "" ? " " : escapeXml(line)}</tspan>`,
    )
    .join("");
  parts.push(`<text font-size="${TEXT_FONT_SIZE}" font-weight="400" fill="${COLOR_PRIMARY}">${tspans}</text>`);

  parts.push(`</svg>`);

  return {
    svg: parts.join(""),
    layout: { width: TWEET_WIDTH, height, avatarBox },
  };
}
