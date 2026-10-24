import { definedFields } from "./fields.js";
import type {
  AuthorizationContext,
  CommentRef,
  ConnectedAccountRef,
  DeliveryOutcome,
  DeliveryRef,
  JsonObject,
  JsonValue,
  LinkMetadata,
  MediaAttachment,
  MediaInput,
  MediaRef,
  PlatformPostRef,
  PreparationIssue,
  PublishContent,
  PublishRequest,
  PublishSequenceRequest,
  PublishTarget,
  RetryDisposition,
  ScheduledJobRef,
  TargetContentOverride,
} from "./types.js";
import {
  isBoolean,
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  type JsonField,
} from "../transport/validation.js";

/** Thrown when stored or submitted data does not match the durable schedule format. */
export class ScheduleDecodeError extends Error {
  readonly path: string;

  constructor(path: string, expected: string) {
    super(`${path} must be ${expected}`);
    this.name = "ScheduleDecodeError";
    this.path = path;
  }
}

function obj(value: JsonField, path: string): JsonObject {
  if (!isJsonObject(value)) throw new ScheduleDecodeError(path, "an object");

  return value;
}

function arr(value: JsonField, path: string): readonly JsonValue[] {
  if (!isJsonArray(value)) throw new ScheduleDecodeError(path, "an array");

  return value;
}

function str(value: JsonField, path: string): string {
  if (!isString(value)) throw new ScheduleDecodeError(path, "a string");

  return value;
}

function nonEmpty(value: JsonField, path: string): string {
  const text = str(value, path);

  if (text === "") throw new ScheduleDecodeError(path, "a nonempty string");

  return text;
}

function optStr(value: JsonField, path: string): string | undefined {
  return value === undefined ? undefined : str(value, path);
}

function num(value: JsonField, path: string): number {
  if (!isFiniteNumber(value)) throw new ScheduleDecodeError(path, "a finite number");

  return value;
}

function optNum(value: JsonField, path: string): number | undefined {
  return value === undefined ? undefined : num(value, path);
}

function int(value: JsonField, path: string): number {
  const number = num(value, path);

  if (!Number.isSafeInteger(number) || number < 0)
    throw new ScheduleDecodeError(path, "a nonnegative integer");

  return number;
}

function optBool(value: JsonField, path: string): boolean | undefined {
  if (value === undefined) return undefined;

  if (!isBoolean(value)) throw new ScheduleDecodeError(path, "a boolean");

  return value;
}

function literal<const T extends string>(value: JsonField, path: string, allowed: readonly T[]): T {
  const match = allowed.find((candidate) => candidate === value);

  if (match === undefined) throw new ScheduleDecodeError(path, `one of ${allowed.join(", ")}`);

  return match;
}

function optional<T>(
  value: JsonField,
  path: string,
  decode: (value: JsonValue, path: string) => T,
): T | undefined {
  return value === undefined ? undefined : decode(value, path);
}

function list<T>(
  value: JsonField,
  path: string,
  decode: (value: JsonValue, path: string) => T,
): T[] {
  return arr(value, path).map((item, index) => decode(item, `${path}[${index}]`));
}

function versionOne(value: JsonObject, path: string): 1 {
  if (value["version"] !== 1) throw new ScheduleDecodeError(`${path}.version`, "1");

  return 1;
}

function kind<const K extends string>(value: JsonObject, path: string, expected: K): K {
  return literal(value["kind"], `${path}.kind`, [expected]);
}

export function decodeAccount(value: JsonField, path: string): ConnectedAccountRef {
  const o = obj(value, path);

  return {
    kind: kind(o, path, "connected-account"),
    version: versionOne(o, path),
    backend: nonEmpty(o["backend"], `${path}.backend`),
    platform: nonEmpty(o["platform"], `${path}.platform`),
    accountId: nonEmpty(o["accountId"], `${path}.accountId`),
  };
}

function accountScoped(o: JsonObject, path: string) {
  return {
    version: versionOne(o, path),
    backend: nonEmpty(o["backend"], `${path}.backend`),
    platform: nonEmpty(o["platform"], `${path}.platform`),
    accountId: nonEmpty(o["accountId"], `${path}.accountId`),
  };
}

export function decodePostRef(value: JsonField, path: string): PlatformPostRef {
  const o = obj(value, path);

  return {
    kind: kind(o, path, "platform-post"),
    ...accountScoped(o, path),
    postId: nonEmpty(o["postId"], `${path}.postId`),
    ...definedFields({ native: optional(o["native"], `${path}.native`, obj) }),
  };
}

function decodeCommentRef(o: JsonObject, path: string): CommentRef {
  return {
    kind: kind(o, path, "comment"),
    ...accountScoped(o, path),
    postId: nonEmpty(o["postId"], `${path}.postId`),
    commentId: nonEmpty(o["commentId"], `${path}.commentId`),
  };
}

function decodeReplyRef(value: JsonField, path: string): CommentRef | PlatformPostRef {
  const o = obj(value, path);

  return o["kind"] === "comment" ? decodeCommentRef(o, path) : decodePostRef(o, path);
}

function decodeDeliveryRef(value: JsonField, path: string): DeliveryRef {
  const o = obj(value, path);

  return {
    kind: kind(o, path, "delivery"),
    ...accountScoped(o, path),
    deliveryId: nonEmpty(o["deliveryId"], `${path}.deliveryId`),
  };
}

export function decodeJobRef(value: JsonField, path: string): ScheduledJobRef {
  const o = obj(value, path);

  return {
    kind: kind(o, path, "scheduled-job"),
    ...accountScoped(o, path),
    jobId: nonEmpty(o["jobId"], `${path}.jobId`),
  };
}

function decodeMediaRef(value: JsonField, path: string): MediaRef {
  const o = obj(value, path);

  return {
    kind: kind(o, path, "media"),
    ...accountScoped(o, path),
    mediaId: nonEmpty(o["mediaId"], `${path}.mediaId`),
  };
}

/** Only sources that stay valid outside the scheduling process; Blob and stream are rejected. */
function decodeMediaInput(value: JsonField, path: string): MediaInput {
  const o = obj(value, path);
  const sourceKind = literal(o["kind"], `${path}.kind`, ["https-url", "media-ref"]);

  if (sourceKind === "https-url")
    return { kind: sourceKind, url: nonEmpty(o["url"], `${path}.url`) };

  return { kind: sourceKind, ref: decodeMediaRef(o["ref"], `${path}.ref`) };
}

function decodeMedia(value: JsonField, path: string): MediaAttachment {
  const o = obj(value, path);

  return {
    kind: literal(o["kind"], `${path}.kind`, ["image", "video", "document"]),
    source: decodeMediaInput(o["source"], `${path}.source`),
    ...definedFields({
      mimeType: optStr(o["mimeType"], `${path}.mimeType`),
      filename: optStr(o["filename"], `${path}.filename`),
      byteSize: optNum(o["byteSize"], `${path}.byteSize`),
      width: optNum(o["width"], `${path}.width`),
      height: optNum(o["height"], `${path}.height`),
      durationSeconds: optNum(o["durationSeconds"], `${path}.durationSeconds`),
      altText: optStr(o["altText"], `${path}.altText`),
      caption: optStr(o["caption"], `${path}.caption`),
      thumbnail: optional(o["thumbnail"], `${path}.thumbnail`, decodeMediaInput),
    }),
  };
}

function decodeLink(value: JsonField, path: string): LinkMetadata {
  const o = obj(value, path);

  return {
    url: nonEmpty(o["url"], `${path}.url`),
    ...definedFields({
      title: optStr(o["title"], `${path}.title`),
      description: optStr(o["description"], `${path}.description`),
    }),
  };
}

function decodeContent(value: JsonField, path: string): PublishContent & TargetContentOverride {
  const o = obj(value, path);

  return definedFields({
    text: optStr(o["text"], `${path}.text`),
    media: optional(o["media"], `${path}.media`, (media, at) => list(media, at, decodeMedia)),
    link: optional(o["link"], `${path}.link`, decodeLink),
  });
}

function decodeTarget(value: JsonField, path: string): PublishTarget {
  const o = obj(value, path);

  return {
    account: decodeAccount(o["account"], `${path}.account`),
    ...definedFields({
      content: optional(o["content"], `${path}.content`, decodeContent),
      replyTo: optional(o["replyTo"], `${path}.replyTo`, decodeReplyRef),
      options: optional(o["options"], `${path}.options`, obj),
    }),
  };
}

export function decodePublishRequest(value: JsonField, path: string): PublishRequest {
  const o = obj(value, path);

  return {
    targets: list(o["targets"], `${path}.targets`, decodeTarget),
    content: decodeContent(o["content"], `${path}.content`),
    ...definedFields({
      idempotencyKey: optStr(o["idempotencyKey"], `${path}.idempotencyKey`),
      correlationId: optStr(o["correlationId"], `${path}.correlationId`),
      replyTo: optional(o["replyTo"], `${path}.replyTo`, decodeReplyRef),
      schedule: optional(o["schedule"], `${path}.schedule`, (schedule, at) => {
        const s = obj(schedule, at);

        return {
          at: nonEmpty(s["at"], `${at}.at`),
          ...definedFields({ timeZone: optStr(s["timeZone"], `${at}.timeZone`) }),
        };
      }),
    }),
  };
}

export function decodeSequenceRequest(value: JsonField, path: string): PublishSequenceRequest {
  const o = obj(value, path);

  return {
    items: list(o["items"], `${path}.items`, (item, at) => {
      const i = obj(item, at);

      return {
        targets: list(i["targets"], `${at}.targets`, decodeTarget),
        content: decodeContent(i["content"], `${at}.content`),
        ...definedFields({ replyTo: optional(i["replyTo"], `${at}.replyTo`, decodeReplyRef) }),
      };
    }),
    idempotencyKey: nonEmpty(o["idempotencyKey"], `${path}.idempotencyKey`),
    ...definedFields({
      stopOnFailure: optBool(o["stopOnFailure"], `${path}.stopOnFailure`),
      replyToPrevious: optBool(o["replyToPrevious"], `${path}.replyToPrevious`),
    }),
  };
}

export function decodeAuthorization(value: JsonField, path: string): AuthorizationContext {
  const o = obj(value, path);

  return definedFields({
    tenantId: optStr(o["tenantId"], `${path}.tenantId`),
    principalId: optStr(o["principalId"], `${path}.principalId`),
    attributes: optional(o["attributes"], `${path}.attributes`, obj),
  });
}

function decodeRetryDisposition(value: JsonField, path: string): RetryDisposition {
  const o = obj(value, path);

  const dispositionKind = literal(o["kind"], `${path}.kind`, [
    "never",
    "after-delay",
    "after-reconnect",
    "reconcile-first",
  ]);

  if (dispositionKind === "after-delay") {
    const delayMs = num(o["delayMs"], `${path}.delayMs`);

    if (delayMs < 0) throw new ScheduleDecodeError(`${path}.delayMs`, "nonnegative");

    return { kind: dispositionKind, delayMs };
  }

  return { kind: dispositionKind };
}

function decodeIssue(value: JsonField, path: string): PreparationIssue {
  const o = obj(value, path);

  return {
    code: str(o["code"], `${path}.code`),
    message: str(o["message"], `${path}.message`),
    severity: literal(o["severity"], `${path}.severity`, ["error", "warning"]),
    ...definedFields({
      path: optStr(o["path"], `${path}.path`),
      targetIndex: optional(o["targetIndex"], `${path}.targetIndex`, int),
    }),
  };
}

export function decodeOutcome(value: JsonField, path: string): DeliveryOutcome {
  const o = obj(value, path);

  const base = {
    targetIndex: int(o["targetIndex"], `${path}.targetIndex`),
    account: decodeAccount(o["account"], `${path}.account`),
    observedAt: str(o["observedAt"], `${path}.observedAt`),
    ...definedFields({
      delivery: optional(o["delivery"], `${path}.delivery`, decodeDeliveryRef),
      backendState: optStr(o["backendState"], `${path}.backendState`),
      retryAttemptId: optStr(o["retryAttemptId"], `${path}.retryAttemptId`),
    }),
  };

  const state = literal(o["state"], `${path}.state`, [
    "not-submitted",
    "scheduled",
    "accepted",
    "processing",
    "published",
    "failed",
    "cancelled",
    "unknown",
  ]);

  switch (state) {
    case "not-submitted":
      return {
        ...base,
        state,
        reason: literal(o["reason"], `${path}.reason`, [
          "validation",
          "unauthorized",
          "idempotency-conflict",
          "capacity",
          "before-submission",
        ]),
        ...definedFields({
          issues: optional(o["issues"], `${path}.issues`, (issues, at) =>
            list(issues, at, decodeIssue),
          ),
        }),
      };
    case "scheduled":
      return { ...base, state, job: decodeJobRef(o["job"], `${path}.job`) };
    case "accepted":
    case "processing":
      return { ...base, state };
    case "published":
      return {
        ...base,
        state,
        post: decodePostRef(o["post"], `${path}.post`),
        ...definedFields({ url: optStr(o["url"], `${path}.url`) }),
      };
    case "failed":
      return {
        ...base,
        state,
        code: str(o["code"], `${path}.code`),
        message: str(o["message"], `${path}.message`),
        retryDisposition: decodeRetryDisposition(o["retryDisposition"], `${path}.retryDisposition`),
        ...definedFields({ mediaId: optStr(o["mediaId"], `${path}.mediaId`) }),
      };
    case "cancelled":
      return {
        ...base,
        state,
        ...definedFields({ reason: optStr(o["reason"], `${path}.reason`) }),
      };
    case "unknown":
      return {
        ...base,
        state,
        reason: literal(o["reason"], `${path}.reason`, ["ambiguous-submission", "unmapped-state"]),
        ...definedFields({
          mediaId: optStr(o["mediaId"], `${path}.mediaId`),
          diagnostic: optStr(o["diagnostic"], `${path}.diagnostic`),
        }),
      };
    default: {
      const _exhaustive: never = state;

      return _exhaustive;
    }
  }
}

export const codec = {
  obj,
  arr,
  str,
  nonEmpty,
  optStr,
  int,
  optBool,
  literal,
  optional,
  list,
  versionOne,
};
