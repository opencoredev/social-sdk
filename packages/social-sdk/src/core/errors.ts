import type {
  ConnectedAccountRef,
  JsonObject,
  PreparationIssue,
  RetryDisposition,
} from "./types.js";

export type SocialErrorCode =
  | "invalid_config"
  | "invalid_input"
  | "unsupported_capability"
  | "missing_permission"
  | "reconnect_required"
  | "ineligible_account"
  | "approval_required"
  | "rate_limited"
  | "billing_required"
  | "media_error"
  | "not_found"
  | "gone"
  | "upstream_failure"
  | "ambiguous_outcome"
  | "cancelled"
  | "timeout"
  | "runtime_unsupported"
  | "unauthorized"
  | "idempotency_conflict";

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
