// The post preflight checker: given post text, a media plan, and platforms, it
// says per platform whether the post fits (pass), needs something the page can't
// see (warn), or breaks a published limit (fail). Pure, so the page script and the
// tests run the same code.
import {
  platformSpec,
  type DurationRule,
  type PlatformId,
  type PlatformSpec,
  type SizeLimit,
} from "./platforms";
import {
  graphemeCount,
  isValidXText,
  tagCounts,
  threadsLength,
  utf16Length,
  utf8Bytes,
  xWeightedLength,
} from "./text-count";

export type MediaPlan =
  | { kind: "none" }
  | { kind: "image"; sizeMb?: number | undefined }
  | { kind: "carousel"; count: number; sizeMb?: number | undefined }
  | { kind: "video"; seconds?: number | undefined; sizeMb?: number | undefined };

export type MediaKind = MediaPlan["kind"];

export const mediaKinds: readonly MediaKind[] = ["none", "image", "carousel", "video"];

export function isMediaKind(value: string): value is MediaKind {
  return mediaKinds.some((kind) => kind === value);
}

export type Verdict = "pass" | "warn" | "fail";

export type Check = { verdict: Verdict; label: string; detail: string };

/** How much of the text budget the post uses, for the meter. */
export type TextMeter = { used: number; limit: number; unit: string };

export type PlatformResult = {
  platform: PlatformId;
  name: string;
  verdict: Verdict;
  checks: Check[];
  meter: TextMeter | null;
  notes: string[];
};

const rank: Readonly<Record<Verdict, number>> = { pass: 0, warn: 1, fail: 2 };

function worst(checks: readonly Check[]): Verdict {
  let verdict: Verdict = "pass";

  for (const check of checks) if (rank[check.verdict] > rank[verdict]) verdict = check.verdict;

  return verdict;
}

const number = (value: number) => value.toLocaleString("en-US");

/** The text measured in the platform's own unit, or null when it publishes no limit. */
function measureText(spec: PlatformSpec, text: string, media: MediaPlan): TextMeter | null {
  const rule = spec.text;

  switch (rule.kind) {
    case "x-weighted":
      return {
        used: xWeightedLength(text).weighted,
        limit: rule.limit,
        unit: "weighted characters",
      };
    case "graphemes":
      return { used: graphemeCount(text), limit: rule.limit, unit: "graphemes" };
    case "threads":
      return { used: threadsLength(text), limit: rule.limit, unit: "characters" };
    case "utf16": {
      const photo = media.kind === "image" || media.kind === "carousel";

      return {
        used: utf16Length(text),
        limit: photo && rule.photoLimit !== undefined ? rule.photoLimit : rule.limit,
        unit: "characters",
      };
    }

    case "utf8-bytes":
      return { used: utf8Bytes(text), limit: rule.limit, unit: "bytes" };
    case "none":
      return null;
    default: {
      const exhaustive: never = rule;

      return exhaustive;
    }
  }
}

function textChecks(spec: PlatformSpec, text: string, media: MediaPlan) {
  const checks: Check[] = [];

  const notes: string[] = [];

  const meter = measureText(spec, text, media);

  if (meter !== null) {
    const excess = meter.used - meter.limit;

    checks.push(
      excess > 0
        ? {
            verdict: "fail",
            label: "Text",
            detail: `${number(meter.used)} of ${number(meter.limit)} ${meter.unit}: ${number(excess)} over.`,
          }
        : {
            verdict: "pass",
            label: "Text",
            detail: `${number(meter.used)} of ${number(meter.limit)} ${meter.unit}.`,
          },
    );
  }

  const rule = spec.text;

  if (rule.kind === "x-weighted") {
    const { urls } = xWeightedLength(text);

    if (text.length > 0 && !isValidXText(text) && (meter === null || meter.used <= meter.limit))
      checks.push({
        verdict: "fail",
        label: "Characters",
        detail: `${spec.name} rejects invalid Unicode characters such as non-characters (U+FFFE/U+FFFF).`,
      });

    if (urls > 0)
      notes.push(
        `${urls} ${urls === 1 ? "URL counts" : "URLs count"} as 23 characters each. X bills a post with a URL at the higher Post: Create (with URL) rate.`,
      );
  }

  if (rule.kind === "graphemes") {
    const bytes = utf8Bytes(text);

    if (bytes > rule.maxBytes)
      checks.push({
        verdict: "fail",
        label: "Text bytes",
        detail: `${number(bytes)} of ${number(rule.maxBytes)} UTF-8 bytes.`,
      });
  }

  if (rule.kind === "utf8-bytes" && rule.noAngleBrackets && /[<>]/u.test(text))
    checks.push({
      verdict: "fail",
      label: "Characters",
      detail: `${spec.name} descriptions can't contain angle brackets (< or >).`,
    });

  if (rule.kind === "utf8-bytes")
    notes.push(
      "The text becomes the video description. A title of 1 to 100 characters is set separately.",
    );

  if (rule.kind === "none") notes.push("Facebook publishes no text limit for Page posts.");

  if (spec.tags !== undefined) {
    const tags = tagCounts(text);

    if (tags.hashtags > spec.tags.hashtags)
      checks.push({
        verdict: "fail",
        label: "Hashtags",
        detail: `${tags.hashtags} hashtags; the limit is ${spec.tags.hashtags}.`,
      });

    if (tags.mentions > spec.tags.mentions)
      checks.push({
        verdict: "fail",
        label: "@ tags",
        detail: `${tags.mentions} @ tags; the limit is ${spec.tags.mentions}.`,
      });
  }

  return { checks, notes, meter };
}

function sizeCheck(
  label: string,
  sizeMb: number | undefined,
  limit: SizeLimit | undefined,
): Check[] {
  if (sizeMb === undefined || limit === undefined) return [];

  const bytes = sizeMb * 1_000_000;

  return [
    bytes > limit.bytes
      ? { verdict: "fail", label, detail: `${number(sizeMb)} MB is over the ${limit.label} limit.` }
      : { verdict: "pass", label, detail: `${number(sizeMb)} MB fits the ${limit.label} limit.` },
  ];
}

function mediaChecks(spec: PlatformSpec, media: MediaPlan, hasText: boolean) {
  const checks: Check[] = [];

  const notes: string[] = [];

  switch (media.kind) {
    case "none":
      if (!spec.textOnly)
        checks.push({
          verdict: "fail",
          label: "Media",
          detail:
            spec.video !== null && spec.image === null
              ? `${spec.name} posts need exactly one video.`
              : `${spec.name} posts need at least one image or video.`,
        });
      else if (!hasText)
        checks.push({
          verdict: "fail",
          label: "Content",
          detail: "Add text or media: the post is empty.",
        });
      break;
    case "image":
      if (spec.image === null)
        checks.push({ verdict: "fail", label: "Media", detail: `${spec.name} takes video only.` });
      else
        checks.push(
          { verdict: "pass", label: "Media", detail: `One image (${spec.image.formats}).` },
          ...sizeCheck("Image size", media.sizeMb, spec.image.size),
        );
      break;
    case "carousel": {
      if (spec.carousel === null || spec.image === null) {
        checks.push({
          verdict: "fail",
          label: "Media",
          detail: `${spec.name} takes one video, not several images.`,
        });
        break;
      }

      const { min, max, warnAbove } = spec.carousel;

      if (media.count < min || media.count > max)
        checks.push({
          verdict: "fail",
          label: "Media count",
          detail: `${media.count} items; ${spec.name} takes ${min} to ${max} in one post.`,
        });
      else if (warnAbove !== undefined && media.count > warnAbove.count)
        checks.push({ verdict: "warn", label: "Media count", detail: warnAbove.reason });
      else
        checks.push({
          verdict: "pass",
          label: "Media count",
          detail: `${media.count} of up to ${max} items.`,
        });

      checks.push(...sizeCheck("Item size", media.sizeMb, spec.image.size));
      break;
    }

    case "video": {
      const video = spec.video;

      if (video === null) {
        checks.push({ verdict: "fail", label: "Media", detail: `${spec.name} takes no video.` });
        break;
      }

      checks.push({ verdict: "pass", label: "Media", detail: `One video (${video.formats}).` });
      checks.push(...sizeCheck("Video size", media.sizeMb, video.size));

      if (
        media.sizeMb !== undefined &&
        video.minSize !== undefined &&
        media.sizeMb * 1_000_000 < video.minSize.bytes
      )
        checks.push({
          verdict: "fail",
          label: "Video size",
          detail: `${number(media.sizeMb)} MB is under the ${video.minSize.label} minimum.`,
        });

      if (video.sizeNote !== undefined) notes.push(video.sizeNote);

      checks.push(...durationChecks(video.duration, media.seconds));

      if (video.duration.note !== undefined) notes.push(video.duration.note);
      break;
    }

    default: {
      const exhaustive: never = media;

      return exhaustive;
    }
  }

  return { checks, notes };
}

function durationChecks(rule: DurationRule, seconds: number | undefined): Check[] {
  const label = "Duration";

  if (seconds === undefined)
    return rule.lengthRequired === true
      ? [
          {
            verdict: "warn",
            label,
            detail: "Enter the video's length: the SDK rejects a video without a known duration.",
          },
        ]
      : [];

  if (rule.lengthRequired === true && seconds <= 0)
    return [
      {
        verdict: "fail",
        label,
        detail: `${number(seconds)} s: the video needs a known length above 0 s.`,
      },
    ];

  if (rule.min !== undefined && seconds < rule.min)
    return [
      {
        verdict: "fail",
        label,
        detail: `${number(seconds)} s is under the ${number(rule.min)} s minimum.`,
      },
    ];

  if (rule.max !== undefined && seconds > rule.max)
    return [
      {
        verdict: "fail",
        label,
        detail: `${number(seconds)} s is over the ${number(rule.max)} s limit.`,
      },
    ];

  if (rule.warnAbove !== undefined && seconds > rule.warnAbove.seconds)
    return [{ verdict: "warn", label, detail: rule.warnAbove.reason }];

  return rule.min === undefined && rule.max === undefined
    ? []
    : [{ verdict: "pass", label, detail: `${number(seconds)} s is within the limit.` }];
}

/** Checks one post against one platform. */
export function checkPlatform(
  platform: PlatformId,
  text: string,
  media: MediaPlan,
): PlatformResult {
  const spec = platformSpec(platform);

  const textResult = textChecks(spec, text, media);

  const mediaResult = mediaChecks(spec, media, text.trim() !== "");

  const checks = [...textResult.checks, ...mediaResult.checks];

  return {
    platform,
    name: spec.name,
    verdict: worst(checks),
    checks,
    meter: textResult.meter,
    notes: [...textResult.notes, ...mediaResult.notes],
  };
}

/** Checks one post against every selected platform, in the order given. */
export function preflight(
  text: string,
  platforms: readonly PlatformId[],
  media: MediaPlan,
): PlatformResult[] {
  return platforms.map((platform) => checkPlatform(platform, text, media));
}
