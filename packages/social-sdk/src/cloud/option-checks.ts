import type {
  JsonObject,
  JsonValue,
  PreparationIssue,
  PreparedPublishTarget,
} from "../core/types.js";
import { definedFields } from "../core/fields.js";
import { httpsUrl } from "../transport/upload.js";
import {
  isBoolean,
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  type JsonField,
} from "../transport/validation.js";

/**
 * Local checks for managed publish options. Each reader returns the decoded value or records an
 * issue and returns `undefined`, so `prepareTarget` reports every problem at once and
 * `publishTarget` can trust the values it maps.
 */
export interface OptionReader {
  readonly issues: PreparationIssue[];
  readonly config: JsonObject;
  fail(code: string, message: string): void;
  has(key: string): boolean;
  text(key: string, code: string, max?: number): string | undefined;
  flag(key: string, code: string): boolean | undefined;
  integer(key: string, code: string, min: number, max: number): number | undefined;
  url(key: string, code: string): string | undefined;
  texts(
    key: string,
    code: string,
    limits: { readonly min?: number; readonly max: number; readonly length?: number },
  ): readonly string[] | undefined;
  countries(key: string, code: string): readonly string[] | undefined;
}

export function optionReader(target: PreparedPublishTarget, config: JsonObject): OptionReader {
  const issues: PreparationIssue[] = [];

  const fail = (code: string, message: string) =>
    issues.push({ code, message, severity: "error", targetIndex: target.targetIndex });

  const text = (key: string, code: string, max = Number.MAX_SAFE_INTEGER) => {
    const value = config[key];

    if (value === undefined) return undefined;

    if (!isString(value) || value.trim() === "" || value.length > max) {
      fail(code, `${key} must be a non-empty string of at most ${max} characters.`);

      return undefined;
    }

    return value;
  };

  const texts: OptionReader["texts"] = (key, code, limits) => {
    const value = config[key];

    if (value === undefined) return undefined;

    const items = isJsonArray(value) ? value.filter(isString) : [];
    const max = limits.length ?? Number.MAX_SAFE_INTEGER;

    if (
      !isJsonArray(value) ||
      items.length !== value.length ||
      items.length < (limits.min ?? 1) ||
      items.length > limits.max ||
      items.some((item) => item.trim() === "" || item.length > max)
    ) {
      fail(
        code,
        `${key} must list ${limits.min ?? 1} to ${limits.max} non-empty strings${
          limits.length === undefined ? "" : ` of at most ${limits.length} characters`
        }.`,
      );

      return undefined;
    }

    return items;
  };

  return {
    issues,
    config,
    fail,
    has: (key) => config[key] !== undefined,
    text,
    texts,
    flag(key, code) {
      const value = config[key];

      if (value === undefined) return undefined;

      if (!isBoolean(value)) {
        fail(code, `${key} must be a boolean.`);

        return undefined;
      }

      return value;
    },
    integer(key, code, min, max) {
      const value = config[key];

      if (value === undefined) return undefined;

      if (!isFiniteNumber(value) || !Number.isInteger(value) || value < min || value > max) {
        fail(code, `${key} must be an integer from ${min} to ${max}.`);

        return undefined;
      }

      return value;
    },
    url(key, code) {
      const value = text(key, code);

      if (value === undefined) return undefined;

      try {
        return httpsUrl(value).href;
      } catch {
        fail(code, `${key} must be a public HTTPS URL.`);

        return undefined;
      }
    },
    countries(key, code) {
      const value = config[key];

      if (value === undefined) return undefined;

      const fields = isJsonObject(value) ? value : {};
      const countries = fields["countries"];

      const list =
        isJsonArray(countries) &&
        countries.length >= 1 &&
        countries.length <= 25 &&
        Object.keys(fields).length === 1
          ? countries.filter((item): item is string => isString(item) && /^[A-Z]{2}$/.test(item))
          : [];

      if (!isJsonArray(countries) || list.length !== countries.length || list.length === 0) {
        fail(code, `${key}.countries must list 1 to 25 uppercase ISO 3166-1 alpha-2 codes.`);

        return undefined;
      }

      return list;
    },
  };
}

export interface ThreadItem {
  readonly text?: string;
  readonly media: readonly {
    readonly kind: "image" | "video";
    readonly url: string;
    readonly altText?: string;
  }[];
}

/** Decode `threadItems`: each later post needs text or public HTTPS media. */
export function threadItems(
  reader: OptionReader,
  maxText: number,
): readonly ThreadItem[] | undefined {
  const value = reader.config["threadItems"];

  if (value === undefined) return undefined;

  const bad = () => {
    reader.fail(
      "options.thread_items",
      `threadItems must list 1 to 25 posts, each with text of at most ${maxText} characters or public HTTPS image or video URLs.`,
    );

    return undefined;
  };

  if (!isJsonArray(value) || value.length === 0 || value.length > 25) return bad();

  const items: ThreadItem[] = [];

  for (const entry of value) {
    if (!isJsonObject(entry)) return bad();

    const text = entry["text"];
    const media = entry["media"] ?? [];

    if (
      (text !== undefined && (!isString(text) || text.trim() === "" || text.length > maxText)) ||
      !isJsonArray(media) ||
      Object.keys(entry).some((key) => key !== "text" && key !== "media")
    )
      return bad();

    const decoded: ThreadItem["media"][number][] = [];

    for (const item of media) {
      const parsed = threadMedia(item);

      if (parsed === undefined) return bad();
      decoded.push(parsed);
    }

    if (!isString(text) && decoded.length === 0) return bad();

    items.push({ ...definedFields({ text: isString(text) ? text : undefined }), media: decoded });
  }

  return items;
}

function threadMedia(value: JsonField): ThreadItem["media"][number] | undefined {
  if (!isJsonObject(value)) return undefined;

  const { kind, url, altText } = value;

  if ((kind !== "image" && kind !== "video") || !isString(url)) return undefined;

  if (altText !== undefined && !isString(altText)) return undefined;

  try {
    return {
      kind,
      url: httpsUrl(url).href,
      ...definedFields({ altText: isString(altText) ? altText : undefined }),
    };
  } catch {
    return undefined;
  }
}

/** A JSON object of known boolean flags, at least one true. */
export function flagSet(
  reader: OptionReader,
  key: string,
  flags: readonly string[],
  code: string,
): Record<string, boolean> | undefined {
  const value = reader.config[key];

  if (value === undefined) return undefined;

  const result: Record<string, boolean> = {};

  if (isJsonObject(value))
    for (const [name, flag] of Object.entries(value))
      if (flags.includes(name) && isBoolean(flag)) result[name] = flag;

  if (
    !isJsonObject(value) ||
    Object.keys(result).length !== Object.keys(value).length ||
    !Object.values(result).includes(true)
  ) {
    reader.fail(code, `${key} takes ${flags.join(", ")} as booleans, with at least one true.`);

    return undefined;
  }

  return result;
}

/** Topic tags: 1 to 50 characters, no periods or ampersands (Threads). */
export function topicTag(reader: OptionReader): string | undefined {
  const value = reader.text("topicTag", "threads.topic_tag", 50);

  if (value !== undefined && /[.&]/.test(value)) {
    reader.fail("threads.topic_tag", "topicTag cannot contain periods or ampersands.");

    return undefined;
  }

  return value;
}

/** X polls: 2 to 4 options of 1 to 25 characters, open 5 to 10080 minutes. */
export function xPoll(
  reader: OptionReader,
): { readonly options: readonly string[]; readonly durationMinutes: number } | undefined {
  const value = reader.config["poll"];

  if (value === undefined) return undefined;

  const options = isJsonObject(value) ? value["options"] : undefined;
  const duration = isJsonObject(value) ? value["durationMinutes"] : undefined;

  const choices = isJsonArray(options)
    ? options.filter(
        (item): item is string => isString(item) && item.length >= 1 && item.length <= 25,
      )
    : [];

  if (
    !isJsonObject(value) ||
    !isJsonArray(options) ||
    choices.length !== options.length ||
    choices.length < 2 ||
    choices.length > 4 ||
    !isFiniteNumber(duration) ||
    !Number.isInteger(duration) ||
    duration < 5 ||
    duration > 10080
  ) {
    reader.fail(
      "x.poll",
      "poll needs 2 to 4 options of 1 to 25 characters and durationMinutes from 5 to 10080.",
    );

    return undefined;
  }

  return { options: choices, durationMinutes: duration };
}

/** A list of objects decoded by `decode`; any invalid entry fails the whole list. */
export function objectList<T>(
  reader: OptionReader,
  key: string,
  code: string,
  limits: { readonly min: number; readonly max: number },
  decode: (entry: JsonObject) => T | undefined,
  message: string,
): readonly T[] | undefined {
  const value = reader.config[key];

  if (value === undefined) return undefined;

  const decoded: T[] = [];

  if (isJsonArray(value))
    for (const entry of value) {
      const item = isJsonObject(entry) ? decode(entry) : undefined;

      if (item !== undefined) decoded.push(item);
    }

  if (
    !isJsonArray(value) ||
    decoded.length !== value.length ||
    decoded.length < limits.min ||
    decoded.length > limits.max
  ) {
    reader.fail(code, message);

    return undefined;
  }

  return decoded;
}

/** Copy only defined values, so an omitted option sends nothing. */
export function assignDefined(
  into: Record<string, JsonValue>,
  values: Readonly<Record<string, JsonValue | undefined>>,
): void {
  for (const [key, value] of Object.entries(values)) if (value !== undefined) into[key] = value;
}
