import type {
  CommentRef,
  ConnectedAccountRef,
  JsonObject,
  LinkMetadata,
  MediaAttachment,
  MediaInput,
  MediaRef,
  PlatformPostRef,
  PublishContent,
  PublishRequest,
  PublishTarget,
} from "./core/types.js";
import { definedFields } from "./core/fields.js";
import { isJsonValue } from "./transport/json.js";
import {
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  type JsonField,
} from "./transport/validation.js";

/**
 * A JSON publish request the CLI cannot hand to `prepare`. The message names the
 * offending path and never repeats the submitted value.
 */
export class PublishRequestInputError extends Error {
  override readonly name = "PublishRequestInputError";
}

/** JSON diagnostics deliberately accept only portable URLs, never executable streams or Blob handles. */
const httpsMediaOnlyMessage =
  "CLI media validation accepts HTTPS URL inputs only. Validate Blob/stream/media handles through the SDK.";

function fail(path: string, expectation: string): never {
  throw new PublishRequestInputError(`Invalid publish request: ${path} must be ${expectation}.`);
}

function objectAt(value: JsonField, path: string): JsonObject {
  if (!isJsonObject(value)) fail(path, "an object");

  return value;
}

function stringAt(value: JsonField, path: string): string {
  if (!isString(value)) fail(path, "a string");

  return value;
}

function optionalStringAt(value: JsonField, path: string): string | undefined {
  return value === undefined ? undefined : stringAt(value, path);
}

function optionalNumberAt(value: JsonField, path: string): number | undefined {
  if (value === undefined) return undefined;

  if (!isFiniteNumber(value)) fail(path, "a finite number");

  return value;
}

function versionAt(value: JsonField, path: string): 1 {
  if (value !== 1) fail(path, "1");

  return value;
}

function connectedAccount(value: JsonField, path: string): ConnectedAccountRef {
  const input = objectAt(value, path);

  if (input["kind"] !== "connected-account") fail(`${path}.kind`, '"connected-account"');

  return {
    kind: input["kind"],
    version: versionAt(input["version"], `${path}.version`),
    backend: stringAt(input["backend"], `${path}.backend`),
    platform: stringAt(input["platform"], `${path}.platform`),
    accountId: stringAt(input["accountId"], `${path}.accountId`),
  };
}

function mediaRef(input: JsonObject, path: string): MediaRef {
  if (input["kind"] !== "media") fail(`${path}.kind`, '"media"');

  return {
    kind: input["kind"],
    version: versionAt(input["version"], `${path}.version`),
    backend: stringAt(input["backend"], `${path}.backend`),
    mediaId: stringAt(input["mediaId"], `${path}.mediaId`),
    platform: stringAt(input["platform"], `${path}.platform`),
    accountId: stringAt(input["accountId"], `${path}.accountId`),
  };
}

function replyReference(value: JsonField, path: string): CommentRef | PlatformPostRef {
  const input = objectAt(value, path);
  const kind = input["kind"];

  const base = {
    version: versionAt(input["version"], `${path}.version`),
    backend: stringAt(input["backend"], `${path}.backend`),
    platform: stringAt(input["platform"], `${path}.platform`),
    accountId: stringAt(input["accountId"], `${path}.accountId`),
    postId: stringAt(input["postId"], `${path}.postId`),
  };

  if (kind === "comment")
    return { kind, ...base, commentId: stringAt(input["commentId"], `${path}.commentId`) };

  if (kind !== "platform-post") fail(`${path}.kind`, '"platform-post" or "comment"');

  const native = input["native"];

  return {
    kind,
    ...base,
    ...definedFields({
      native: native === undefined ? undefined : objectAt(native, `${path}.native`),
    }),
  };
}

function mediaSource(value: JsonField, path: string): MediaInput {
  if (!isJsonObject(value) || value["kind"] !== "https-url")
    throw new PublishRequestInputError(httpsMediaOnlyMessage);

  return { kind: value["kind"], url: stringAt(value["url"], `${path}.url`) };
}

/** Thumbnails were never limited to URLs by the CLI, so JSON media references stay accepted. */
function thumbnailSource(value: JsonField, path: string): MediaInput {
  const input = objectAt(value, path);

  if (input["kind"] === "https-url")
    return { kind: input["kind"], url: stringAt(input["url"], `${path}.url`) };

  if (input["kind"] === "media-ref")
    return {
      kind: input["kind"],
      ref: mediaRef(objectAt(input["ref"], `${path}.ref`), `${path}.ref`),
    };

  return fail(`${path}.kind`, '"https-url" or "media-ref"');
}

function mediaAttachment(value: JsonField, path: string): MediaAttachment {
  const input = objectAt(value, path);
  const kind = input["kind"];

  if (kind !== "image" && kind !== "video") fail(`${path}.kind`, '"image" or "video"');

  const thumbnail = input["thumbnail"];

  return {
    kind,
    source: mediaSource(input["source"], `${path}.source`),
    ...definedFields({
      mimeType: optionalStringAt(input["mimeType"], `${path}.mimeType`),
      filename: optionalStringAt(input["filename"], `${path}.filename`),
      byteSize: optionalNumberAt(input["byteSize"], `${path}.byteSize`),
      width: optionalNumberAt(input["width"], `${path}.width`),
      height: optionalNumberAt(input["height"], `${path}.height`),
      durationSeconds: optionalNumberAt(input["durationSeconds"], `${path}.durationSeconds`),
      altText: optionalStringAt(input["altText"], `${path}.altText`),
      caption: optionalStringAt(input["caption"], `${path}.caption`),
      thumbnail:
        thumbnail === undefined ? undefined : thumbnailSource(thumbnail, `${path}.thumbnail`),
    }),
  };
}

function link(value: JsonField, path: string): LinkMetadata {
  const input = objectAt(value, path);

  return {
    url: stringAt(input["url"], `${path}.url`),
    ...definedFields({
      title: optionalStringAt(input["title"], `${path}.title`),
      description: optionalStringAt(input["description"], `${path}.description`),
    }),
  };
}

function content(value: JsonField, path: string): PublishContent {
  const input = objectAt(value, path);
  const media = input["media"];
  const linkInput = input["link"];

  if (media !== undefined && !isJsonArray(media)) fail(`${path}.media`, "an array");

  return definedFields({
    text: optionalStringAt(input["text"], `${path}.text`),
    media: media?.map((item, index) => mediaAttachment(item, `${path}.media[${index}]`)),
    link: linkInput === undefined ? undefined : link(linkInput, `${path}.link`),
  });
}

function target(value: JsonField, path: string): PublishTarget {
  const input = objectAt(value, path);
  const override = input["content"];
  const replyTo = input["replyTo"];
  const options = input["options"];

  return {
    account: connectedAccount(input["account"], `${path}.account`),
    ...definedFields({
      content: override === undefined ? undefined : content(override, `${path}.content`),
      replyTo: replyTo === undefined ? undefined : replyReference(replyTo, `${path}.replyTo`),
      // Each adapter validates its own option fields during `prepare`.
      options: options === undefined ? undefined : objectAt(options, `${path}.options`),
    }),
  };
}

function schedule(value: JsonField, path: string): NonNullable<PublishRequest["schedule"]> {
  const input = objectAt(value, path);

  return {
    at: stringAt(input["at"], `${path}.at`),
    ...definedFields({ timeZone: optionalStringAt(input["timeZone"], `${path}.timeZone`) }),
  };
}

/**
 * Parse and decode CLI input text into a `PublishRequest`. This checks the
 * request's structure; `prepare` still reports semantic problems such as an
 * unknown backend, an empty target list, or a past schedule as diagnostics.
 * Text that is not JSON throws the `SyntaxError` from `JSON.parse`.
 */
export function decodePublishRequest(text: string): PublishRequest {
  const parsed: unknown = JSON.parse(text);

  if (!isJsonValue(parsed) || !isJsonObject(parsed) || !isJsonArray(parsed["targets"]))
    throw new PublishRequestInputError("Expected a JSON publish request with a targets array.");

  const scheduleInput = parsed["schedule"];
  const replyTo = parsed["replyTo"];

  return {
    targets: parsed["targets"].map((item, index) => target(item, `targets[${index}]`)),
    content: content(parsed["content"], "content"),
    ...definedFields({
      idempotencyKey: optionalStringAt(parsed["idempotencyKey"], "idempotencyKey"),
      correlationId: optionalStringAt(parsed["correlationId"], "correlationId"),
      schedule: scheduleInput === undefined ? undefined : schedule(scheduleInput, "schedule"),
      replyTo: replyTo === undefined ? undefined : replyReference(replyTo, "replyTo"),
    }),
  };
}
