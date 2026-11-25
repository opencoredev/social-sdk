// Parses the post limits page's media fields into the MediaPlan the checker
// takes. A value the checker can't use is reported against its field instead of
// being replaced, so the page never checks a post the reader didn't describe.
import { isMediaKind, type MediaPlan } from "./preflight";

export type MediaField = "count" | "seconds" | "size";

/** One form field as the browser reports it. `badInput` is the field's `validity.badInput`. */
export type RawField = { value: string; badInput: boolean };

export type RawMedia = {
  kind: string;
  count: RawField;
  seconds: RawField;
  size: RawField;
};

export type FieldError = { field: MediaField; message: string };

export type MediaParse = { kind: "ok"; media: MediaPlan } | { kind: "error"; errors: FieldError[] };

type FieldResult<T> = { kind: "ok"; value: T } | { kind: "error"; message: string };

/** Left empty. A number field the browser couldn't read also reports "", so `badInput` tells them apart. */
const isBlank = (field: RawField) => field.value.trim() === "" && !field.badInput;

function readNumber(field: RawField): FieldResult<number> {
  if (field.badInput) return { kind: "error", message: "Enter a number." };

  const value = Number(field.value);

  return Number.isFinite(value)
    ? { kind: "ok", value }
    : { kind: "error", message: "Enter a number." };
}

function itemCount(field: RawField): FieldResult<number> {
  if (isBlank(field)) return { kind: "error", message: "Enter how many items the post has." };

  const parsed = readNumber(field);

  if (parsed.kind === "error") return parsed;

  return Number.isInteger(parsed.value) && parsed.value >= 1
    ? parsed
    : { kind: "error", message: "Enter a whole number of items, 1 or more." };
}

function seconds(field: RawField): FieldResult<number | undefined> {
  if (isBlank(field)) return { kind: "ok", value: undefined };

  const parsed = readNumber(field);

  if (parsed.kind === "error") return parsed;

  return parsed.value >= 0
    ? parsed
    : { kind: "error", message: "Enter a length of 0 seconds or more." };
}

function sizeMb(field: RawField): FieldResult<number | undefined> {
  if (isBlank(field)) return { kind: "ok", value: undefined };

  const parsed = readNumber(field);

  if (parsed.kind === "error") return parsed;

  return parsed.value > 0 ? parsed : { kind: "error", message: "Enter a file size above 0 MB." };
}

/** Parses the media fields that apply to the chosen kind; the others are ignored. */
export function parseMedia(raw: RawMedia): MediaParse {
  const kind = isMediaKind(raw.kind) ? raw.kind : "none";

  if (kind === "none") return { kind: "ok", media: { kind } };

  const errors: FieldError[] = [];

  const size = sizeMb(raw.size);

  if (size.kind === "error") errors.push({ field: "size", message: size.message });

  switch (kind) {
    case "image":
      return size.kind === "ok"
        ? { kind: "ok", media: { kind, sizeMb: size.value } }
        : { kind: "error", errors };
    case "carousel": {
      const count = itemCount(raw.count);

      if (count.kind === "error") errors.unshift({ field: "count", message: count.message });

      return count.kind === "ok" && size.kind === "ok"
        ? { kind: "ok", media: { kind, count: count.value, sizeMb: size.value } }
        : { kind: "error", errors };
    }

    case "video": {
      const length = seconds(raw.seconds);

      if (length.kind === "error") errors.unshift({ field: "seconds", message: length.message });

      return length.kind === "ok" && size.kind === "ok"
        ? { kind: "ok", media: { kind, seconds: length.value, sizeMb: size.value } }
        : { kind: "error", errors };
    }

    default: {
      const exhaustive: never = kind;

      return exhaustive;
    }
  }
}
