/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- webhook bodies are unknown until validated by the decoder. */
import { parseJson } from "../transport/json.js";
import { SocialError } from "../core/errors.js";
import { array, object, optionalString, string } from "../transport/validation.js";
import type { JsonObject, JsonValue } from "../core/types.js";

export interface VerifiedWebhook {
  readonly valid: true;
  readonly method: "hmac-sha256" | "shared-secret-header";
  readonly bodyAuthenticated: boolean;
  readonly signedTimestamp: false;
}

function denied(): never {
  throw new SocialError({
    code: "unauthorized",
    operation: "webhooks.verify",
    message:
      "Webhook authentication failed. Check the configured endpoint secret and preserve the raw request bytes.",
  });
}

function checkedBytes(body: Uint8Array, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || body.byteLength > maxBytes) denied();

  return new Uint8Array(body);
}

export async function verifyZernioWebhook(input: {
  secret: string;
  headers: Headers;
  body: Uint8Array;
  maxBytes?: number;
}): Promise<VerifiedWebhook> {
  if (!input.secret) denied();
  const signature = input.headers.get("X-Zernio-Signature");

  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) denied();
  const bytes = new Uint8Array(32);

  for (let index = 0; index < 32; index++)
    bytes[index] = Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      bytes,
      checkedBytes(input.body, input.maxBytes ?? 1024 * 1024),
    ))
  )
    denied();

  return { valid: true, method: "hmac-sha256", bodyAuthenticated: true, signedTimestamp: false };
}

export async function verifyPostForMeWebhook(input: {
  secret: string;
  headers: Headers;
  body: Uint8Array;
  maxBytes?: number;
}): Promise<VerifiedWebhook> {
  checkedBytes(input.body, input.maxBytes ?? 1024 * 1024);
  const supplied = input.headers.get("Post-For-Me-Webhook-Secret");

  if (!input.secret || !supplied || supplied.length > 4096) denied();

  // WebCrypto verifies fixed-size keyed digests, avoiding a JS early-exit string comparison.
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input.secret));

  if (!(await crypto.subtle.verify("HMAC", key, expected, new TextEncoder().encode(supplied))))
    denied();

  return {
    valid: true,
    method: "shared-secret-header",
    bodyAuthenticated: false,
    signedTimestamp: false,
  };
}

export interface SocialEvent {
  readonly version: 1;
  readonly id: string;
  readonly backend: string;
  readonly provider: "zernio" | "post-for-me";
  readonly type:
    | "publication.updated"
    | "post.removed"
    | "backend-record.deleted"
    | "account.updated"
    | "message.received"
    | "comment.received"
    | "unknown";
  readonly identity: "provider-event-id" | "body-digest";
  readonly originalType: string;
  readonly occurredAt?: string;
  readonly receivedAt: string;
  readonly accountIds: readonly string[];
  readonly backendRecordId?: string;
  readonly data: JsonObject;
}

const sensitive =
  /^(access.?token|refresh.?token|authorization|cookie|secret|signature|code|password|signed.?url|upload.?url)$/i;

function clean(value: unknown, depth = 0): JsonValue {
  if (depth > 32)
    throw new SocialError({
      code: "invalid_input",
      operation: "webhooks.decode",
      message: "Webhook payload nesting exceeds the limit.",
    });

  if (value === null || typeof value === "boolean" || typeof value === "number") return value;

  if (typeof value === "string") {
    if (/https:\/\//i.test(value) && /[?&](x-amz-|signature|token|sig|key)=?/i.test(value))
      return "[redacted URL]";

    return value;
  }

  if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1));
  const result: Record<string, JsonValue> = {};

  for (const [key, entry] of Object.entries(object(value)))
    result[key] = sensitive.test(key) ? "[redacted]" : clean(entry, depth + 1);

  return result;
}

export async function decodeWebhook(input: {
  provider: "zernio" | "post-for-me";
  backend: string;
  body: Uint8Array;
  receivedAt?: string;
}): Promise<SocialEvent> {
  const bytes = checkedBytes(input.body, 1024 * 1024);
  let parsed: unknown;

  try {
    parsed = parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SocialError({
      code: "invalid_input",
      operation: "webhooks.decode",
      message: "Webhook body is not valid UTF-8 JSON.",
    });
  }

  const payload = object(parsed);
  const providerId = optionalString(payload["id"]);

  // Post for Me's open-source sender omits its internal event ID from the payload.
  // Exact-body deduplication is a weaker fallback, explicitly reported to callers.
  if (input.provider === "zernio" && !providerId) denied();

  const id =
    providerId ??
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

  const originalType = string(
    input.provider === "zernio" ? payload["event"] : payload["event_type"],
  );

  let type: SocialEvent["type"] = "unknown";

  if (
    /^(post\.(scheduled|platform\.published|platform\.failed|tiktok\.url_resolved|published|partial|failed)|social\.post\.(created|updated|result\.created))$/.test(
      originalType,
    )
  )
    type = "publication.updated";
  else if (/^post\.(platform|external)\.deleted$/.test(originalType)) type = "post.removed";
  else if (originalType === "social.post.deleted") type = "backend-record.deleted";
  else if (
    /^(account\.(connected|disconnected)|social\.account\.(created|updated))$/.test(originalType)
  )
    type = "account.updated";
  else if (originalType === "message.received") type = "message.received";
  else if (originalType === "comment.received") type = "comment.received";
  const dataValue = input.provider === "zernio" ? payload : object(payload["data"]);
  const cleaned = clean(dataValue);

  if (typeof cleaned !== "object" || cleaned === null || Array.isArray(cleaned))
    throw new Error("Expected normalized object");
  // IDs only locate application mappings; they never grant tenant ownership.
  const accountIds: string[] = [];

  const direct =
    optionalString(dataValue["accountId"]) ?? optionalString(dataValue["social_account_id"]);

  if (direct) accountIds.push(direct);

  if (dataValue["account"] && typeof dataValue["account"] === "object") {
    const account = object(dataValue["account"]);

    const accountId =
      optionalString(account["accountId"]) ??
      optionalString(account["_id"]) ??
      optionalString(account["id"]);

    if (accountId) accountIds.push(accountId);
  }

  if (input.provider === "post-for-me" && originalType.startsWith("social.account."))
    accountIds.push(string(dataValue["id"]));

  if (dataValue["post"] && typeof dataValue["post"] === "object") {
    const post = object(dataValue["post"]);

    if (post["platforms"])
      for (const value of array(post["platforms"])) {
        const entry = object(value);
        const accountId = optionalString(entry["accountId"]);

        if (accountId) accountIds.push(accountId);
      }
  }

  if (input.provider === "post-for-me" && Array.isArray(dataValue["social_accounts"])) {
    for (const item of dataValue["social_accounts"]) {
      const id = typeof item === "string" ? item : optionalString(object(item)["id"]);

      if (id) accountIds.push(id);
    }
  }

  const post =
    dataValue["post"] && typeof dataValue["post"] === "object"
      ? object(dataValue["post"])
      : undefined;

  const backendRecordId =
    input.provider === "zernio"
      ? (optionalString(post?.["id"]) ?? optionalString(post?.["_id"]))
      : originalType === "social.post.result.created"
        ? optionalString(dataValue["post_id"])
        : originalType.startsWith("social.post.")
          ? optionalString(dataValue["id"])
          : undefined;

  const occurredAt = optionalString(payload["timestamp"]) ?? optionalString(payload["created_at"]);

  const eventBase: SocialEvent = {
    version: 1,
    id,
    identity: providerId ? "provider-event-id" : "body-digest",
    backend: input.backend,
    provider: input.provider,
    type,
    originalType,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    accountIds: [...new Set(accountIds)],
    data: cleaned as JsonObject,
  };

  const event: SocialEvent =
    backendRecordId === undefined
      ? occurredAt === undefined
        ? eventBase
        : { ...eventBase, occurredAt }
      : occurredAt === undefined
        ? { ...eventBase, backendRecordId }
        : { ...eventBase, backendRecordId, occurredAt };

  return event;
}

export interface EventInbox {
  /** Atomically persist event, route resolution, and pending processing state. */
  accept(input: {
    key: string;
    event: SocialEvent;
    tenantIds: readonly string[];
    state: "pending" | "quarantined";
  }): Promise<"accepted" | "duplicate">;
}

export async function acceptWebhook(input: {
  event: SocialEvent;
  endpointId: string;
  inbox: EventInbox;
  resolveTenants: (backend: string, accountIds: readonly string[]) => Promise<readonly string[]>;
}): Promise<{ state: "accepted" | "duplicate"; quarantined: boolean }> {
  // Resolve every account independently. A union lookup cannot distinguish a
  // fully mapped event from one containing both known and unknown accounts.
  let commonTenants: Set<string> | undefined;

  for (const accountId of new Set(input.event.accountIds)) {
    const tenants = new Set(
      (await input.resolveTenants(input.event.backend, [accountId])).filter(Boolean),
    );

    commonTenants =
      commonTenants === undefined
        ? tenants
        : new Set([...commonTenants].filter((tenant) => tenants.has(tenant)));

    if (commonTenants.size === 0) break;
  }

  // The full event may contain data about every account. Only tenants authorized
  // for every account may receive it; unrelated tenants must never share payloads.
  const tenantIds = [...(commonTenants ?? [])];
  const quarantined = tenantIds.length === 0;

  const key = JSON.stringify([
    1,
    input.event.provider,
    input.event.backend,
    input.endpointId,
    input.event.id,
  ]);

  const state = await input.inbox.accept({
    key,
    event: input.event,
    tenantIds,
    state: quarantined ? "quarantined" : "pending",
  });

  return { state, quarantined };
}
