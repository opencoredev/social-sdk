import {
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  type JsonField,
} from "../transport/validation.js";
import type {
  ConnectedAccountRef,
  JsonObject,
  JsonValue,
  PreparationIssue,
  RetryDisposition,
} from "./types.js";

const socialErrorCodes = [
  "invalid_config",
  "invalid_input",
  "unsupported_capability",
  "missing_permission",
  "reconnect_required",
  "ineligible_account",
  "approval_required",
  "rate_limited",
  "billing_required",
  "media_error",
  "not_found",
  "gone",
  "upstream_failure",
  "ambiguous_outcome",
  "cancelled",
  "timeout",
  "runtime_unsupported",
  "unauthorized",
  "idempotency_conflict",
] as const;

export type SocialErrorCode = (typeof socialErrorCodes)[number];

export interface SocialErrorOptions {
  readonly code: SocialErrorCode;
  readonly operation: string;
  readonly message: string;
  readonly backend?: string | undefined;
  readonly account?: ConnectedAccountRef | undefined;
  readonly issues?: readonly PreparationIssue[] | undefined;
  readonly correlationId?: string | undefined;
  readonly upstreamStatus?: number | undefined;
  readonly upstreamCode?: string | undefined;
  readonly retryDisposition?: RetryDisposition;
  readonly details?: JsonObject | undefined;
  readonly cause?: unknown;
}

export interface SerializedSocialError {
  readonly name: "SocialError";
  readonly code: SocialErrorCode;
  readonly operation: string;
  readonly message: string;
  readonly backend?: string;
  readonly account?: ConnectedAccountRef;
  readonly issues?: readonly PreparationIssue[];
  readonly correlationId?: string;
  readonly upstreamStatus?: number;
  readonly upstreamCode?: string;
  readonly retryDisposition: RetryDisposition;
  readonly details?: JsonObject;
}

export class SocialError extends Error {
  readonly code: SocialErrorCode;
  readonly operation: string;
  readonly backend: string | undefined;
  readonly account: ConnectedAccountRef | undefined;
  readonly issues: readonly PreparationIssue[] | undefined;
  readonly correlationId: string | undefined;
  readonly upstreamStatus: number | undefined;
  readonly upstreamCode: string | undefined;
  readonly retryDisposition: RetryDisposition;
  readonly details: JsonObject | undefined;

  constructor(options: SocialErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "SocialError";
    this.code = options.code;
    this.operation = options.operation;
    this.backend = options.backend;
    this.account = options.account;
    this.issues = options.issues;
    this.correlationId = options.correlationId;
    this.upstreamStatus = options.upstreamStatus;
    this.upstreamCode = options.upstreamCode;
    this.retryDisposition = options.retryDisposition ?? { kind: "never" };
    this.details = options.details;
  }

  /**
   * Rebuilds an error from `toJSON()` output, either directly or after it was parsed back from JSON,
   * such as one passed back from a queue worker. The value is untrusted: anything that is not a
   * serialized `SocialError` throws `invalid_input`.
   */
  static fromJSON(value: JsonValue | SerializedSocialError): SocialError {
    if (!isSerializedErrorObject(value) || value["name"] !== "SocialError")
      return invalidSerializedError("value");

    const { code, operation, message, retryDisposition } = value;

    if (!isSocialErrorCode(code)) return invalidSerializedError("code");

    if (!isString(operation)) return invalidSerializedError("operation");

    if (!isString(message)) return invalidSerializedError("message");

    return new SocialError({
      code,
      operation,
      message,
      backend: optionalField(value, "backend", isString),
      account: optionalField(value, "account", isConnectedAccountRef),
      issues: optionalField(value, "issues", isPreparationIssues),
      correlationId: optionalField(value, "correlationId", isString),
      upstreamStatus: optionalField(value, "upstreamStatus", isFiniteNumber),
      upstreamCode: optionalField(value, "upstreamCode", isString),
      retryDisposition: decodeRetryDisposition(retryDisposition),
      details: optionalField(value, "details", isJsonObject),
    });
  }

  toJSON(): SerializedSocialError {
    const serialized: SerializedSocialError = {
      name: "SocialError",
      code: this.code,
      operation: this.operation,
      message: this.message,
      retryDisposition: this.retryDisposition,
    };

    if (this.backend !== undefined) Object.assign(serialized, { backend: this.backend });

    if (this.account !== undefined) Object.assign(serialized, { account: this.account });

    if (this.issues !== undefined) Object.assign(serialized, { issues: this.issues });

    if (this.correlationId !== undefined)
      Object.assign(serialized, { correlationId: this.correlationId });

    if (this.upstreamStatus !== undefined)
      Object.assign(serialized, { upstreamStatus: this.upstreamStatus });

    if (this.upstreamCode !== undefined)
      Object.assign(serialized, { upstreamCode: this.upstreamCode });

    if (this.details !== undefined) Object.assign(serialized, { details: this.details });

    return serialized;
  }
}

function invalidSerializedError(field: string): never {
  throw new SocialError({
    code: "invalid_input",
    operation: "SocialError.fromJSON",
    message: `Serialized SocialError has an invalid ${field}.`,
  });
}

// Every value of a SerializedSocialError is JSON, so an object of either input shape is a JsonObject;
// its fields are still decoded one by one below.
function isSerializedErrorObject(value: JsonValue | SerializedSocialError): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSocialErrorCode(value: JsonField): value is SocialErrorCode {
  return socialErrorCodes.some((code) => code === value);
}

// An absent key stays absent; a present key must match its decoder.
function optionalField<T extends JsonField>(
  value: JsonObject,
  field: string,
  matches: (item: JsonField) => item is T,
): T | undefined {
  const item = value[field];

  if (item === undefined) return undefined;

  return matches(item) ? item : invalidSerializedError(field);
}

function decodeRetryDisposition(value: JsonField): RetryDisposition {
  if (!isJsonObject(value)) return invalidSerializedError("retryDisposition");

  const { kind, delayMs } = value;

  if (kind === "after-delay" && isFiniteNumber(delayMs) && delayMs >= 0) return { kind, delayMs };

  // Only an after-delay disposition carries a delay.
  if (
    delayMs === undefined &&
    (kind === "never" || kind === "after-reconnect" || kind === "reconcile-first")
  )
    return { kind };

  return invalidSerializedError("retryDisposition");
}

function isConnectedAccountRef(value: JsonField): value is ConnectedAccountRef & JsonObject {
  return (
    isJsonObject(value) &&
    value["kind"] === "connected-account" &&
    value["version"] === 1 &&
    isString(value["backend"]) &&
    isString(value["platform"]) &&
    isString(value["accountId"])
  );
}

function isPreparationIssue(value: JsonValue): value is PreparationIssue & JsonObject {
  if (!isJsonObject(value)) return false;

  const { code, message, path, targetIndex, severity } = value;

  return (
    isString(code) &&
    isString(message) &&
    (path === undefined || isString(path)) &&
    (targetIndex === undefined || isFiniteNumber(targetIndex)) &&
    (severity === "error" || severity === "warning")
  );
}

function isPreparationIssues(
  value: JsonField,
): value is readonly (PreparationIssue & JsonObject)[] {
  return isJsonArray(value) && value.every(isPreparationIssue);
}
