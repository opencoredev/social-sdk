// Text counters for the post preflight checker. They follow the rules the SDK
// adapters check before sending (packages/social-sdk/src/platforms): Bluesky
// graphemes and bytes, Threads code points with emoji as UTF-8 bytes, and X's
// weighted length. The X count is the SDK's own `xWeightedLength`, the function
// `isValidXText` compares against 280, so the page and the SDK cannot disagree.
export {
  isValidXText,
  xWeightedLength,
} from "../../../../packages/social-sdk/src/platforms/x-text.ts";

const encoder = new TextEncoder();

let segmenter: Intl.Segmenter | undefined;

function segments(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });

  return Array.from(segmenter.segment(text), (part) => part.segment);
}

export function graphemeCount(text: string): number {
  return segments(text).length;
}

export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/** JavaScript string length: what the Instagram, LinkedIn, and TikTok adapters check. */
export function utf16Length(text: string): number {
  return text.length;
}

/** Emoji sequences, in the forms the Threads adapter recognizes. */
function emojiPattern(): RegExp {
  try {
    return new RegExp("\\p{RGI_Emoji}", "gv");
  } catch {
    // Browsers without the `v` flag: a close approximation of RGI_Emoji.
    return /(?:\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*)/gu;
  }
}

/** Threads: ordinary code points count as one each, emoji by their UTF-8 bytes. */
export function threadsLength(text: string): number {
  let emojiBytes = 0;

  const ordinary = text.replace(emojiPattern(), (match) => {
    emojiBytes += utf8Bytes(match);

    return "";
  });

  return Array.from(ordinary).length + emojiBytes;
}

const hashtagPattern = /(?:^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu;

const mentionPattern = /(?:^|[^A-Za-z0-9._])@[A-Za-z0-9._]+/g;

export type TagCounts = { hashtags: number; mentions: number };

/** Hashtags and @ tags, counted the way the Instagram adapter counts them. */
export function tagCounts(text: string): TagCounts {
  return {
    hashtags: text.match(hashtagPattern)?.length ?? 0,
    mentions: text.match(mentionPattern)?.length ?? 0,
  };
}
