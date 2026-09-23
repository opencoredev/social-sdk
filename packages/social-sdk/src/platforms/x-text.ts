import { xTopLevelDomains } from "./x-tlds.js";

// X counts post length with weighted characters, following the v3 rules published in twitter-text:
// most Latin-range code points weigh 1, everything else weighs 2, each emoji weighs 2 and each URL
// weighs 23. Everything is scaled by 100 so the arithmetic stays in integers like the reference config.
const maxWeightedLength = 280 * 100;

const defaultWeight = 200;

const urlWeight = 23 * 100;

const lightRanges: readonly (readonly [number, number])[] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

const invalidCharacters = /[\uFFFE\uFEFF\uFFFF\u202A-\u202E]/u;

const emoji =
  /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\p{Emoji_Modifier}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3/u;

// Path characters, with up to two levels of balanced parentheses as in Wikipedia links.
const latinAccents = "\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u00FF";

const pathCharacter = `[a-z0-9!*';:=+,.$/%#\\[\\]\\-\\u2013_~@|&${latinAccents}]`;

const url = new RegExp(
  "(?<![a-z0-9@\\uFF20$#\\uFF03])" +
    "(https?://)?" +
    "(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\." +
    `(?:${xTopLevelDomains.replaceAll(" ", "|")}|xn--[a-z0-9-]+)(?![a-z0-9@+-])` +
    "(?::[0-9]+)?" +
    `(/(?:${pathCharacter}|\\((?:${pathCharacter}|\\(${pathCharacter}*\\))*\\))*)?` +
    "(\\?[a-z0-9!?*'@();:&=+$/%#\\[\\]\\-_.,~|]*)?",
  "giu",
);

const pathEnding = new RegExp(`[+\\-a-z0-9=_#/)${latinAccents}]$`, "iu");

const queryEnding = /[a-z0-9\-_&=#/]$/iu;

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
  const [whole, , path, query] = match;
  // X shortens t.co links to their slug, so a longer path is ordinary text.
  const shortLink = /^https?:\/\/t\.co\/[a-z0-9]+/iu.exec(whole);

  if (shortLink !== null && query === undefined) return shortLink[0].length;

  if (query !== undefined) return whole.length - query.length + trimTail(query, queryEnding).length;

  if (path !== undefined) return whole.length - path.length + trimTail(path, pathEnding).length;

  return whole.length;
}

function weightedLength(text: string): number {
  let weight = 0;
  let offset = 0;

  for (const match of text.matchAll(url)) {
    let start = match.index;

    if (match[1] === undefined) {
      // Links without a protocol must not continue a word, path, or file name, and X only links
      // the part of the host after its last underscore.
      if (/[-_./]$/u.test(text.slice(0, start))) continue;
      const host = /^[^/?:]*/u.exec(match[0])?.[0] ?? "";
      start += host.lastIndexOf("_") + 1;
    }

    weight += weighText(text.slice(offset, start)) + urlWeight;
    offset = match.index + linkLength(match);
  }

  return weight + weighText(text.slice(offset));
}

/** Returns whether X would accept the text as a post body by weighted length and characters. */
export function isValidXText(input: string): boolean {
  const text = input.normalize("NFC");

  if (text === "" || invalidCharacters.test(text)) return false;

  return weightedLength(text) <= maxWeightedLength;
}
