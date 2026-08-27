import { escapeXml } from "./svg.ts";
import { wrapText, estimateTextWidth, BOLD_CHAR_WIDTH_RATIO } from "./wrapText.ts";

export const TWEET_WIDTH = 566;

const PADDING = 16;
const AVATAR_SIZE = 40;
const NAME_FONT_SIZE = 15;
const HANDLE_FONT_SIZE = 15;
const TEXT_FONT_SIZE = 15;
const LINE_HEIGHT = 20;
const HEADER_TO_TEXT_GAP = 12;
const TEXT_TO_MEDIA_GAP = 12;
const MEDIA_HEIGHT = 300;
const MEDIA_RADIUS = 12;
const HEADER_TEXT_X = PADDING + AVATAR_SIZE + 8;

const COLOR_BG = "#000000";
const COLOR_PRIMARY = "rgb(230, 233, 234)";
const COLOR_SECONDARY = "rgb(113, 117, 122)";
const COLOR_VERIFIED = "#1D9BF0";
const COLOR_MEDIA_PLACEHOLDER = "#202327";

const FONT_FAMILY = "'Inter', -apple-system, 'system-ui', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const VERIFIED_BADGE_PATH =
  "M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z";

export interface TweetInput {
  displayName: string;
  handle: string;
  verified: boolean;
  tweetText: string;
  hasMedia: boolean;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TweetLayout {
  width: number;
  height: number;
  /** Where the caller should composite the (separately fetched) avatar photo, as a circle. */
  avatarBox: { x: number; y: number; size: number };
  /** Where the caller should composite the (separately fetched) attached photo, or null if `hasMedia` was false. */
  mediaBox: Box | null;
}

export interface BuiltTweet {
  svg: string;
  layout: TweetLayout;
}

/** Builds the static (text/background/badge) layer of the tweet-screenshot template as SVG. */
export function buildTweetSvg(input: TweetInput): BuiltTweet {
  // The tweet body spans the full content width, not just the header's text column.
  const bodyWidth = TWEET_WIDTH - PADDING * 2;
  const bodyLines = wrapText(input.tweetText, bodyWidth, TEXT_FONT_SIZE);

  const headerBottom = PADDING + AVATAR_SIZE;
  const textTop = headerBottom + HEADER_TO_TEXT_GAP;
  const textHeight = bodyLines.length * LINE_HEIGHT;
  const textBottom = textTop + textHeight;

  const mediaBox: Box | null = input.hasMedia
    ? { x: PADDING, y: textBottom + TEXT_TO_MEDIA_GAP, width: bodyWidth, height: MEDIA_HEIGHT }
    : null;

  const height = mediaBox ? mediaBox.y + mediaBox.height + PADDING : textBottom + PADDING;

  const avatarBox = { x: PADDING, y: PADDING, size: AVATAR_SIZE };
  const nameY = PADDING;
  const handleY = PADDING + 20;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${TWEET_WIDTH}" height="${height}" viewBox="0 0 ${TWEET_WIDTH} ${height}">`);
  parts.push(`<rect x="0" y="0" width="${TWEET_WIDTH}" height="${height}" fill="${COLOR_BG}"/>`);
  parts.push(`<style>text { font-family: ${FONT_FAMILY}; }</style>`);

  // Header: display name (+ verified badge) and handle. Avatar itself is composited later.
  parts.push(
    `<text x="${HEADER_TEXT_X}" y="${nameY + 15}" font-size="${NAME_FONT_SIZE}" font-weight="700" fill="${COLOR_PRIMARY}">${escapeXml(input.displayName)}</text>`,
  );
  if (input.verified) {
    const nameWidth = estimateTextWidth(input.displayName, NAME_FONT_SIZE, BOLD_CHAR_WIDTH_RATIO);
    const badgeX = HEADER_TEXT_X + nameWidth + 6;
    parts.push(
      `<g id="verifiedBadge" transform="translate(${badgeX}, ${nameY + 2})"><path fill="${COLOR_VERIFIED}" d="${VERIFIED_BADGE_PATH}"/></g>`,
    );
  }
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

  if (mediaBox) {
    parts.push(
      `<rect x="${mediaBox.x}" y="${mediaBox.y}" width="${mediaBox.width}" height="${mediaBox.height}" rx="${MEDIA_RADIUS}" fill="${COLOR_MEDIA_PLACEHOLDER}"/>`,
    );
  }

  parts.push(`</svg>`);

  return {
    svg: parts.join(""),
    layout: { width: TWEET_WIDTH, height, avatarBox, mediaBox },
  };
}

export { MEDIA_RADIUS };
