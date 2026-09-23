import { xTopLevelDomains } from "./x-tlds.js";

// X counts post length with weighted characters, following the v3 rules published in twitter-text:
// most Latin-range code points weigh 1, everything else weighs 2, each emoji weighs 2 and each URL
// weighs 23. Everything is scaled by 100 so the arithmetic stays in integers like the reference config.
const maxWeightedLength = 280 * 100;

const defaultWeight = 200;

const urlWeight = 23 * 100;

// X leaves links longer than this, counting the protocol twice as twitter-text does, as plain text.
const maxUrlLength = 4096;

const maxShortLinkSlug = 40;

const lightRanges: readonly (readonly [number, number])[] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

const invalidCharacters = /[\uFFFE\uFEFF\uFFFF]/u;

const emoji =
  /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\p{Emoji_Modifier}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3/u;

const latinAccents =
  "\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u00FF\\u0100-\\u024F\\u0253\\u0254\\u0256\\u0257\\u0259\\u025B\\u0263\\u0268\\u026F\\u0272\\u0289\\u028B\\u02BB\\u0300-\\u036F\\u1E00-\\u1EFF";

const cyrillic = "\\u0400-\\u04FF";

// Hosts may use any character except ASCII punctuation, spaces, invalid characters, and directional markers.
const domainCharacter =
  "[^\\s!\"#$%&'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~\\uFFFE\\uFEFF\\uFFFF\\u202A-\\u202E\\u061C\\u200E\\u200F\\u2066-\\u2069]";

// Path characters, with up to two levels of balanced parentheses as in Wikipedia links.
const pathCharacter = `[a-z0-9!*';:=+,.$/%#\\[\\]\\-\\u2013_~@|&${latinAccents}${cyrillic}]`;

const url = new RegExp(
  // A link without a protocol starts at the beginning of a host, which also keeps matching linear.
  `(?:(?<![a-z0-9@\\uFF20$#\\uFF03])(https?://)|(?<![a-z0-9@\\uFF20$#\\uFF03._/-]|${domainCharacter}))` +
    `((?:${domainCharacter}(?:[_-]|${domainCharacter})*\\.)*` +
    `(?:${domainCharacter}(?:-|${domainCharacter})*)?${domainCharacter}\\.` +
    `(?:${xTopLevelDomains.replaceAll(" ", "|")}|xn--[a-z0-9-]+)(?![a-z0-9@+-]))` +
    "(?::[0-9]+)?" +
    `(/(?:${pathCharacter}|\\((?:${pathCharacter}|\\(${pathCharacter}*\\))*\\))*)?` +
    "(\\?[a-z0-9!?*'@();:&=+$/%#\\[\\]\\-_.,~|]*)?",
  "giu",
);

const pathEnding = new RegExp(`[+\\-a-z0-9=_#/)${latinAccents}${cyrillic}]$`, "iu");

const queryEnding = /[a-z0-9\-_&=#/]$/iu;

// Links without a protocol only cover the ASCII and Latin part of the host.
const bareHostCharacter = new RegExp(`[a-z0-9.\\-${latinAccents}]`, "iu");

const bareHost = new RegExp(`^[a-z0-9\\-${latinAccents}]+\\.`, "iu");

let graphemes: Intl.Segmenter | undefined;

function weighText(text: string): number {
  graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let weight = 0;

  for (const { segment } of graphemes.segment(text)) {
    if (emoji.test(segment)) {
      weight += defaultWeight;
      continue;
    }

    for (const character of segment) {
      const codePoint = character.codePointAt(0) ?? 0;
      weight += lightRanges.some(([start, end]) => codePoint >= start && codePoint <= end)
        ? 100
        : defaultWeight;
    }
  }

  return weight;
}

// Drops the characters X leaves out of a link tail, such as a closing period.
function trimTail(tail: string, ending: RegExp): string {
  let trimmed = tail;

  while (trimmed.length > 1 && !ending.test(trimmed)) trimmed = trimmed.slice(0, -1);

  return ending.test(trimmed) ? trimmed : "";
}

function linkLength(match: RegExpMatchArray): number {
  const [whole, , , path, query] = match;
  // X shortens t.co links to their slug, so a longer path is ordinary text.
  const shortLink = /^https?:\/\/t\.co\/([a-z0-9]+)/iu.exec(whole);

  // X leaves t.co links with slugs longer than 40 characters as plain text.
  if (shortLink !== null && (shortLink[1] ?? "").length > maxShortLinkSlug) return 0;

  if (shortLink !== null && query === undefined) return shortLink[0].length;

  if (query !== undefined) return whole.length - query.length + trimTail(query, queryEnding).length;

  if (path !== undefined) return whole.length - path.length + trimTail(path, pathEnding).length;

  return whole.length;
}

// Returns the host in ASCII form, or undefined when it is not a valid internationalized name.
function asciiHost(host: string): string | undefined {
  try {
    return new URL(`https://${host}`).hostname;
  } catch {
    return undefined;
  }
}

function weightedLength(text: string): number {
  let weight = 0;
  let offset = 0;

  for (const match of text.matchAll(url)) {
    const protocol = match[1];
    const host = match[2] ?? "";
    const length = linkLength(match);
    const ascii = asciiHost(host);

    if (length === 0 || ascii === undefined) continue;

    if ((protocol ?? "https://").length + length + ascii.length - host.length > maxUrlLength)
      continue;

    let start = match.index;

    if (protocol === undefined) {
      // Links without a protocol must not continue a word, path, or file name.
      if (/[-_./]$/u.test(text.slice(0, start))) continue;

      let cut = host.length;

      while (cut > 0 && bareHostCharacter.test(host[cut - 1] ?? "")) cut -= 1;

      if (!bareHost.test(host.slice(cut))) continue;

      start += cut;
    }

    weight += weighText(text.slice(offset, start)) + urlWeight;
    offset = match.index + length;
  }

  return weight + weighText(text.slice(offset));
}

/** Returns whether X would accept the text as a post body by weighted length and characters. */
export function isValidXText(input: string): boolean {
  const text = input.normalize("NFC");

  if (text === "" || invalidCharacters.test(text)) return false;

  return weightedLength(text) <= maxWeightedLength;
}
