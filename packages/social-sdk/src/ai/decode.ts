import { definedFields } from "../core/fields.js";
import type {
  BackendPostRef,
  CommentRef,
  ConnectedAccountRef,
  ConversationRef,
  DeliveryRef,
  JsonObject,
  JsonValue,
  PlatformPostRef,
  ScheduledJobRef,
} from "../core/types.js";
import {
  isBoolean,
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  type JsonField,
} from "../transport/validation.js";

/** Tool arguments that do not match the tool's input schema. Messages name a path, never a value. */
export class ToolInputError extends Error {
  override readonly name = "ToolInputError";
}

function fail(path: string, expectation: string): never {
  throw new ToolInputError(`Invalid tool input: ${path} must be ${expectation}.`);
}

export function toolArguments(value: JsonValue | undefined): JsonObject {
  if (value === undefined || value === null) return {};

  if (!isJsonObject(value)) fail("arguments", "an object");

  return value;
}

export function objectAt(value: JsonField, path: string): JsonObject {
  if (!isJsonObject(value)) fail(path, "an object");

  return value;
}

export function textAt(value: JsonField, path: string): string {
  if (!isString(value) || value.trim() === "") fail(path, "a nonempty string");

  return value;
}

export function optionalTextAt(value: JsonField, path: string): string | undefined {
  return value === undefined ? undefined : textAt(value, path);
}

export function optionalBooleanAt(value: JsonField, path: string): boolean | undefined {
  if (value === undefined) return undefined;

  if (!isBoolean(value)) fail(path, "a boolean");

  return value;
}

export function optionalPositiveIntegerAt(value: JsonField, path: string): number | undefined {
  if (value === undefined) return undefined;

  if (!isFiniteNumber(value) || !Number.isSafeInteger(value) || value < 1)
    fail(path, "a positive integer");

  return value;
}

export function textListAt(value: JsonField, path: string): readonly string[] {
  if (!isJsonArray(value) || value.length === 0) fail(path, "a nonempty array of strings");

  return value.map((item, index) => textAt(item, `${path}[${index}]`));
}

export function optionalTextListAt(value: JsonField, path: string): readonly string[] | undefined {
  return value === undefined ? undefined : textListAt(value, path);
}

/** Message and reply bodies are bounded so one tool call cannot carry an unbounded payload. */
export function messageTextAt(value: JsonField, path: string): string {
  const message = textAt(value, path);

  if (message.length > 10_000) fail(path, "at most 10000 characters");

  return message;
}

interface ScopedFields {
  readonly version: 1;
  readonly backend: string;
  readonly platform: string;
  readonly accountId: string;
}

function scoped(input: JsonObject, kind: string, path: string): ScopedFields {
  if (input["kind"] !== kind) fail(`${path}.kind`, `"${kind}"`);

  if (input["version"] !== 1) fail(`${path}.version`, "1");

  return {
    version: 1,
    backend: textAt(input["backend"], `${path}.backend`),
    platform: textAt(input["platform"], `${path}.platform`),
    accountId: textAt(input["accountId"], `${path}.accountId`),
  };
}

export function connectedAccountAt(value: JsonField, path: string): ConnectedAccountRef {
  const input = objectAt(value, path);

  return { kind: "connected-account", ...scoped(input, "connected-account", path) };
}

export function platformPostAt(value: JsonField, path: string): PlatformPostRef {
  const input = objectAt(value, path);
  const native = input["native"];

  return {
    kind: "platform-post",
    ...scoped(input, "platform-post", path),
    postId: textAt(input["postId"], `${path}.postId`),
    ...definedFields({
      native: native === undefined ? undefined : objectAt(native, `${path}.native`),
    }),
  };
}

export function commentAt(value: JsonField, path: string): CommentRef {
  const input = objectAt(value, path);

  return {
    kind: "comment",
    ...scoped(input, "comment", path),
    postId: textAt(input["postId"], `${path}.postId`),
    commentId: textAt(input["commentId"], `${path}.commentId`),
  };
}

export function conversationAt(value: JsonField, path: string): ConversationRef {
  const input = objectAt(value, path);

  return {
    kind: "conversation",
    ...scoped(input, "conversation", path),
    conversationId: textAt(input["conversationId"], `${path}.conversationId`),
  };
}

export function deliveryAt(value: JsonField, path: string): DeliveryRef {
  const input = objectAt(value, path);

  return {
    kind: "delivery",
    ...scoped(input, "delivery", path),
    deliveryId: textAt(input["deliveryId"], `${path}.deliveryId`),
  };
}

export type RemovableRef = PlatformPostRef | BackendPostRef | ScheduledJobRef;

/** The three deletable resources are distinct references, so the kind selects the operation. */
export function removableAt(value: JsonField, path: string): RemovableRef {
  const input = objectAt(value, path);

  switch (input["kind"]) {
    case "platform-post":
      return platformPostAt(input, path);
    case "backend-post":
      return {
        kind: "backend-post",
        ...scoped(input, "backend-post", path),
        recordId: textAt(input["recordId"], `${path}.recordId`),
      };
    case "scheduled-job":
      return {
        kind: "scheduled-job",
        ...scoped(input, "scheduled-job", path),
        jobId: textAt(input["jobId"], `${path}.jobId`),
      };
    default:
      return fail(`${path}.kind`, '"platform-post", "backend-post" or "scheduled-job"');
  }
}
