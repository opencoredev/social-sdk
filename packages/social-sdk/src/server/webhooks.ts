/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- webhook bodies are unknown until validated by the decoder. */
import { parseJson } from "../transport/json.js";
import { SocialError } from "../core/errors.js";
import { array, object, optionalString, string } from "../transport/validation.js";
import type { JsonObject, JsonValue } from "../core/types.js";

export type WebhookVerificationMethod =
  | "hmac-sha1"
  | "hmac-sha256"
  | "hmac-sha384"
  | "hmac-sha512"
  | "shared-secret-header";

export interface VerifiedWebhook {
  readonly valid: true;
  readonly method: WebhookVerificationMethod;
  readonly bodyAuthenticated: boolean;
  /** True only when the provider signs a delivery timestamp together with the body. */
  readonly signedTimestamp: boolean;
  /** ISO time of the signed delivery timestamp, when the provider signs one. */
  readonly signedAt?: string;
}

function denied(
  message = "Webhook authentication failed. Check the configured endpoint secret and preserve the raw request bytes.",
): never {
  throw new SocialError({ code: "unauthorized", operation: "webhooks.verify", message });
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
  readonly provider: "zernio" | "post-for-me" | DirectWebhookPlatform;
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

/*
 * Direct platform webhooks. Official sources, accessed 2026-09-24:
 * - Meta (Instagram, Threads): https://developers.facebook.com/docs/graph-api/webhooks/getting-started,
 *   https://developers.facebook.com/docs/instagram-platform/webhooks,
 *   https://developers.facebook.com/docs/threads/webhooks
 * - X: https://docs.x.com/x-api/webhooks/introduction, https://docs.x.com/x-api/webhooks/quickstart,
 *   https://docs.x.com/x-api/account-activity/introduction
 * - YouTube: https://developers.google.com/youtube/v3/guides/push_notifications,
 *   https://www.w3.org/TR/websub/, https://pubsubhubbub.github.io/PubSubHubbub/pubsubhubbub-core-0.4.html
 * - LinkedIn: https://learn.microsoft.com/en-us/linkedin/shared/api-guide/webhook-validation,
 *   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-social-action-notifications
 * - TikTok: https://developers.tiktok.com/doc/webhooks-verification,
 *   https://developers.tiktok.com/doc/webhooks-events,
 *   https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
 */

export type DirectWebhookPlatform =
  | "instagram"
  | "threads"
  | "x"
  | "youtube"
  | "tiktok"
  | "linkedin";

/** Framework-neutral answer to a provider GET handshake. */
export interface WebhookChallengeResponse {
  readonly status: 200;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface XWebhookChallengeResponse extends WebhookChallengeResponse {
  readonly responseToken: string;
}

export interface YouTubeWebhookChallengeResponse extends WebhookChallengeResponse {
  readonly mode: "subscribe" | "unsubscribe";
  readonly topic: string;
  readonly leaseSeconds?: number;
}

type HmacHash = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

const encoder = new TextEncoder();

const defaultMaxBytes = 1024 * 1024;

function challengeRefused(code: "unauthorized" | "not_found"): never {
  throw new SocialError({
    code,
    operation: "webhooks.challenge",
    message:
      "Webhook handshake refused. Check the configured token or topic and the request query.",
  });
}

async function hmacKey(secret: string, hash: HmacHash, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash },
    false,
    usages,
  );
}

function hexBytes(value: string, length: number): Uint8Array<ArrayBuffer> | undefined {
  if (value.length !== length * 2 || !/^[0-9a-f]+$/i.test(value)) return undefined;
  const bytes = new Uint8Array(length);

  for (let index = 0; index < length; index++)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);

  return bytes;
}

function base64Bytes(value: string, length: number): Uint8Array<ArrayBuffer> | undefined {
  if (value.length !== Math.ceil(length / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    return undefined;
  let binary: string;

  try {
    binary = atob(value);
  } catch {
    return undefined;
  }

  if (binary.length !== length) return undefined;

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64(bytes: ArrayBuffer): string {
  let binary = "";

  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);

  return btoa(binary);
}

async function hmacMatches(
  secret: string,
  hash: HmacHash,
  signature: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  // WebCrypto compares the keyed digest itself, avoiding a JS early-exit comparison.
  return crypto.subtle.verify("HMAC", await hmacKey(secret, hash, ["verify"]), signature, data);
}

async function sameSecret(expected: string, supplied: string): Promise<boolean> {
  // Compare fixed-size keyed digests so the token length and prefix do not leak through timing.
  const key = await hmacKey(expected, "SHA-256", ["sign", "verify"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(expected));

  return crypto.subtle.verify("HMAC", key, digest, encoder.encode(supplied));
}

function bodyVerified(method: WebhookVerificationMethod): VerifiedWebhook {
  return { valid: true, method, bodyAuthenticated: true, signedTimestamp: false };
}

/**
 * Verify a Meta webhook POST for Instagram or Threads. Meta signs the raw body with
 * HMAC-SHA256 using the app secret and sends `X-Hub-Signature-256: sha256=<hex>`.
 */
export async function verifyMetaWebhook(input: {
  secret: string;
  headers: Headers;
  body: Uint8Array;
  maxBytes?: number;
}): Promise<VerifiedWebhook> {
  const body = checkedBytes(input.body, input.maxBytes ?? defaultMaxBytes);

  if (!input.secret) denied();
  const match = /^sha256=([0-9a-f]{64})$/i.exec(input.headers.get("X-Hub-Signature-256") ?? "");
  const signature = match?.[1] === undefined ? undefined : hexBytes(match[1], 32);

  if (!signature || !(await hmacMatches(input.secret, "SHA-256", signature, body))) denied();

  return bodyVerified("hmac-sha256");
}

/**
 * Answer Meta's GET verification request. The verify token is compared in constant
 * time and only a bounded, token-safe `hub.challenge` is echoed.
 */
export async function answerMetaWebhookChallenge(input: {
  verifyToken: string;
  query: URLSearchParams;
}): Promise<WebhookChallengeResponse> {
  const token = input.query.get("hub.verify_token");
  const challenge = input.query.get("hub.challenge");

  if (
    !input.verifyToken ||
    input.query.get("hub.mode") !== "subscribe" ||
    !token ||
    token.length > 4096 ||
    !challenge ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(challenge) ||
    !(await sameSecret(input.verifyToken, token))
  )
    challengeRefused("unauthorized");

  return {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
    body: challenge,
  };
}

/**
 * Verify an X webhook POST. X signs the raw body with HMAC-SHA256 and sends
 * `sha256=<base64>` in `X-Twitter-Webhooks-Signature-OAuth2` (OAuth 2.0 client secret)
 * or the legacy `X-Twitter-Webhooks-Signature` (OAuth 1.0 consumer secret). The
 * OAuth 2.0 header is checked first. Pass the secret that matches your app.
 */
export async function verifyXWebhook(input: {
  secret: string;
  headers: Headers;
  body: Uint8Array;
  maxBytes?: number;
}): Promise<VerifiedWebhook> {
  const body = checkedBytes(input.body, input.maxBytes ?? defaultMaxBytes);

  if (!input.secret) denied();

  for (const name of ["X-Twitter-Webhooks-Signature-OAuth2", "X-Twitter-Webhooks-Signature"]) {
    const match = /^sha256=([A-Za-z0-9+/]{43}=)$/.exec(input.headers.get(name) ?? "");
    const signature = match?.[1] === undefined ? undefined : base64Bytes(match[1], 32);

    if (signature && (await hmacMatches(input.secret, "SHA-256", signature, body)))
      return bodyVerified("hmac-sha256");
  }

  denied();
}

/**
 * Answer X's CRC GET request with `{"response_token":"sha256=<base64>"}`, an
 * HMAC-SHA256 of `crc_token` keyed with the same secret used for signatures.
 */
export async function answerXWebhookChallenge(input: {
  secret: string;
  query: URLSearchParams;
}): Promise<XWebhookChallengeResponse> {
  const crcToken = input.query.get("crc_token");

  if (!input.secret || !crcToken || encoder.encode(crcToken).byteLength > 1024)
    challengeRefused("unauthorized");

  const digest = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(input.secret, "SHA-256", ["sign"]),
    encoder.encode(crcToken),
  );

  const responseToken = `sha256=${base64(digest)}`;

  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_token: responseToken }),
    responseToken,
  };
}

function webSubAlgorithm(
  name: string | undefined,
): { hash: HmacHash; bytes: number; method: WebhookVerificationMethod } | undefined {
  switch (name) {
    case "sha1":
      return { hash: "SHA-1", bytes: 20, method: "hmac-sha1" };
    case "sha256":
      return { hash: "SHA-256", bytes: 32, method: "hmac-sha256" };
    case "sha384":
      return { hash: "SHA-384", bytes: 48, method: "hmac-sha384" };
    case "sha512":
      return { hash: "SHA-512", bytes: 64, method: "hmac-sha512" };
    default:
      return undefined;
  }
}

/**
 * Verify a YouTube push notification delivered through the PubSubHubbub hub. The
 * hub only signs deliveries when the subscription was created with `hub.secret`; it
 * sends `X-Hub-Signature: <method>=<hex>`, and the reported method is returned.
 */
export async function verifyYouTubeWebhook(input: {
  secret: string;
  headers: Headers;
  body: Uint8Array;
  maxBytes?: number;
}): Promise<VerifiedWebhook> {
  const body = checkedBytes(input.body, input.maxBytes ?? defaultMaxBytes);

  if (!input.secret) denied();

  const match = /^(sha1|sha256|sha384|sha512)=([0-9a-f]+)$/i.exec(
    input.headers.get("X-Hub-Signature") ?? "",
  );

  const algorithm = webSubAlgorithm(match?.[1]?.toLowerCase());

  const signature =
    algorithm === undefined || match?.[2] === undefined
      ? undefined
      : hexBytes(match[2], algorithm.bytes);

  if (
    !algorithm ||
    !signature ||
    !(await hmacMatches(input.secret, algorithm.hash, signature, body))
  )
    denied();

  return bodyVerified(algorithm.method);
}

/**
 * Answer the hub's GET verification of intent. The topic must be one the
 * application is currently subscribing to or unsubscribing from; otherwise this
 * throws `not_found`, which WebSub expects as an HTTP 404.
 */
export function answerYouTubeWebhookChallenge(input: {
  query: URLSearchParams;
  topics: readonly string[];
}): YouTubeWebhookChallengeResponse {
  const mode = input.query.get("hub.mode");
  const topic = input.query.get("hub.topic");
  const challenge = input.query.get("hub.challenge");
  const lease = input.query.get("hub.lease_seconds");

  if (
    (mode !== "subscribe" && mode !== "unsubscribe") ||
    !topic ||
    !input.topics.includes(topic) ||
    !challenge ||
    !/^[+\-./0-9=A-Z_a-z]{1,512}$/.test(challenge) ||
    (lease !== null && !/^\d{1,10}$/.test(lease))
  )
    challengeRefused("not_found");

  const response: YouTubeWebhookChallengeResponse = {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff" },
    body: challenge,
    mode,
    topic,
  };

  return mode === "subscribe" && lease !== null
    ? { ...response, leaseSeconds: Number(lease) }
    : response;
}

/**
 * Verify a TikTok webhook POST. `TikTok-Signature: t=<unix seconds>,s=<hex>` carries an
 * HMAC-SHA256 of `<t>.<raw body>` keyed with the app's client secret. TikTok leaves
 * the replay window to the receiver; this defaults to 300 seconds.
 */
export async function verifyTikTokWebhook(input: {
  secret: string;
  headers: Headers;
  body: Uint8Array;
  maxBytes?: number;
  toleranceSeconds?: number;
  now?: () => Date;
}): Promise<VerifiedWebhook> {
  const body = checkedBytes(input.body, input.maxBytes ?? defaultMaxBytes);
  const tolerance = input.toleranceSeconds ?? 300;

  if (!Number.isSafeInteger(tolerance) || tolerance <= 0)
    throw new SocialError({
      code: "invalid_config",
      operation: "webhooks.verify",
      message: "TikTok webhook tolerance must be a positive whole number of seconds.",
    });

  if (!input.secret) denied();
  let timestamp: string | undefined;
  let signatureHex: string | undefined;

  for (const part of (input.headers.get("TikTok-Signature") ?? "").split(",")) {
    const separator = part.indexOf("=");

    if (separator < 0) denied();
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === "t") {
      if (timestamp !== undefined) denied();
      timestamp = value;
    } else if (key === "s") {
      if (signatureHex !== undefined) denied();
      signatureHex = value;
    }
  }

  const signature = signatureHex === undefined ? undefined : hexBytes(signatureHex, 32);

  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signature) denied();
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.byteLength + body.byteLength);
  signed.set(prefix);
  signed.set(body, prefix.byteLength);

  if (!(await hmacMatches(input.secret, "SHA-256", signature, signed))) denied();
  const seconds = Number(timestamp);
  const now = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);

  if (Math.abs(now - seconds) > tolerance)
    denied("Webhook signature is valid but its timestamp is outside the accepted window.");

  return {
    valid: true,
    method: "hmac-sha256",
    bodyAuthenticated: true,
    signedTimestamp: true,
    signedAt: new Date(seconds * 1000).toISOString(),
  };
}

/**
 * Verify a LinkedIn webhook POST. `X-LI-Signature` carries only the lowercase hex
 * HMAC-SHA256 of the literal `hmacsha256=` followed by the raw body, keyed with the
 * app's client secret. LinkedIn sends no signed timestamp.
 */
export async function verifyLinkedInWebhook(input: {
  secret: string;
  headers: Headers;
  body: Uint8Array;
  maxBytes?: number;
}): Promise<VerifiedWebhook> {
  const body = checkedBytes(input.body, input.maxBytes ?? defaultMaxBytes);

  if (!input.secret) denied();

  const signature = hexBytes((input.headers.get("X-LI-Signature") ?? "").trim(), 32);

  if (!signature) denied();

  const prefix = encoder.encode("hmacsha256=");
  const signed = new Uint8Array(prefix.byteLength + body.byteLength);
  signed.set(prefix);
  signed.set(body, prefix.byteLength);

  if (!(await hmacMatches(input.secret, "SHA-256", signature, signed))) denied();

  return bodyVerified("hmac-sha256");
}

export interface LinkedInWebhookChallengeResponse extends WebhookChallengeResponse {
  readonly challengeCode: string;
  readonly challengeResponse: string;
  readonly applicationId?: string;
}

/**
 * Answer LinkedIn's GET validation, which LinkedIn repeats every 2 hours. The
 * response is `{ challengeCode, challengeResponse }`, where `challengeResponse` is the
 * lowercase hex HMAC-SHA256 of `challengeCode` keyed with the client secret. For
 * parent-child applications LinkedIn adds `applicationId`; pass `secretForApplication`
 * to pick that application's client secret. An unknown application is refused.
 */
export async function answerLinkedInWebhookChallenge(input: {
  secret: string;
  query: URLSearchParams;
  secretForApplication?: (applicationId: string) => string | undefined;
}): Promise<LinkedInWebhookChallengeResponse> {
  const challengeCode = input.query.get("challengeCode");
  const applicationId = input.query.get("applicationId");

  if (!challengeCode || !/^[A-Za-z0-9-]{1,128}$/.test(challengeCode))
    challengeRefused("unauthorized");

  if (applicationId !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(applicationId))
    challengeRefused("unauthorized");

  const secret =
    applicationId !== null && input.secretForApplication
      ? input.secretForApplication(applicationId)
      : input.secret;

  if (!secret) challengeRefused("unauthorized");

  const digest = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "SHA-256", ["sign"]),
    encoder.encode(challengeCode),
  );

  const challengeResponse = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  const response: LinkedInWebhookChallengeResponse = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeCode, challengeResponse }),
    challengeCode,
    challengeResponse,
  };

  return applicationId === null ? response : { ...response, applicationId };
}

interface DecodedItem {
  readonly originalType: string;
  readonly type: SocialEvent["type"];
}

interface DecodedDelivery {
  readonly items: readonly DecodedItem[];
  readonly accountIds: readonly string[];
  readonly data: unknown;
  readonly backendRecordId?: string | undefined;
  readonly occurredAt?: string | undefined;
}

function malformed(platform: DirectWebhookPlatform): never {
  throw new SocialError({
    code: "invalid_input",
    operation: "webhooks.decode",
    message: `Webhook body does not match the documented ${platform} notification shape.`,
  });
}

function instagramFieldType(field: string): SocialEvent["type"] {
  return field === "comments" || field === "live_comments" ? "comment.received" : "unknown";
}

function decodeInstagram(payload: Record<string, unknown>): DecodedDelivery {
  if (payload["object"] !== "instagram") malformed("instagram");
  const items: DecodedItem[] = [];
  const accountIds: string[] = [];

  for (const value of array(payload["entry"])) {
    const entry = object(value);
    const id = optionalString(entry["id"]);

    if (id) accountIds.push(id);

    if (entry["changes"] !== undefined)
      for (const change of array(entry["changes"])) {
        const field = string(object(change)["field"]);
        items.push({ originalType: field, type: instagramFieldType(field) });
      }

    if (entry["changed_fields"] !== undefined)
      for (const value of array(entry["changed_fields"])) {
        const field = string(value);
        items.push({ originalType: field, type: instagramFieldType(field) });
      }

    if (entry["messaging"] !== undefined)
      for (const item of array(entry["messaging"])) {
        const messaging = object(item);
        const message = messaging["message"];

        if (message !== undefined) {
          const echo = object(message)["is_echo"] === true;

          items.push({
            originalType: echo ? "message_echoes" : "messages",
            type: echo ? "unknown" : "message.received",
          });
        } else if (messaging["reaction"] !== undefined)
          items.push({ originalType: "message_reactions", type: "unknown" });
        else if (messaging["read"] !== undefined)
          items.push({ originalType: "messaging_seen", type: "unknown" });
        else if (messaging["postback"] !== undefined)
          items.push({ originalType: "messaging_postbacks", type: "unknown" });
        else items.push({ originalType: "messaging", type: "unknown" });
      }
  }

  return { items, accountIds, data: payload };
}

function nestedString(value: unknown, key: string): string | undefined {
  return value === undefined ? undefined : optionalString(object(value)[key]);
}

function decodeThreads(payload: Record<string, unknown>): DecodedDelivery {
  const values = object(payload["values"]);
  const field = string(values["field"]);
  const value = object(values["value"]);

  // Threads identifies the owner differently per field. An unknown owner stays empty
  // so acceptWebhook quarantines the event instead of guessing a tenant.
  const owner =
    field === "replies"
      ? nestedString(value["root_post"], "owner_id")
      : field === "delete"
        ? nestedString(value["owner"], "owner_id")
        : field === "mentions"
          ? optionalString(payload["target_id"])
          : undefined;

  const type: SocialEvent["type"] =
    field === "replies" ? "comment.received" : field === "delete" ? "post.removed" : "unknown";

  return {
    items: [{ originalType: field, type }],
    accountIds: owner ? [owner] : [],
    data: payload,
  };
}

function xEventType(key: string): SocialEvent["type"] {
  if (key === "direct_message_events") return "message.received";

  if (key === "tweet_delete_events") return "post.removed";

  return "unknown";
}

function decodeX(payload: Record<string, unknown>): DecodedDelivery {
  const items: DecodedItem[] = [];
  const accountIds: string[] = [];
  const forUser = optionalString(payload["for_user_id"]);

  if (forUser) accountIds.push(forUser);

  for (const [key, value] of Object.entries(payload))
    if (key.endsWith("_events") && Array.isArray(value))
      items.push({ originalType: key, type: xEventType(key) });

  if (payload["user_event"] !== undefined) {
    const userEvent = object(payload["user_event"]);

    if (userEvent["revoke"] === undefined)
      items.push({ originalType: "user_event", type: "unknown" });
    else {
      const userId = nestedString(object(userEvent["revoke"])["source"], "user_id");

      if (userId) accountIds.push(userId);
      items.push({ originalType: "user_event.revoke", type: "account.updated" });
    }
  }

  return { items, accountIds, data: payload };
}

function xmlEntity(whole: string, entity: string): string {
  const name = entity.toLowerCase();

  if (name === "amp") return "&";

  if (name === "lt") return "<";

  if (name === "gt") return ">";

  if (name === "quot") return '"';

  if (name === "apos") return "'";

  const code = name.startsWith("#x")
    ? Number.parseInt(name.slice(2), 16)
    : Number.parseInt(name.slice(1), 10);

  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
}

function xmlText(value: string): string {
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(value.trim());

  if (cdata?.[1] !== undefined) return cdata[1];

  return value.trim().replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gi, xmlEntity);
}

function xmlElement(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);

  return match?.[1] === undefined ? undefined : xmlText(match[1]);
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(` ${attributes}`);

  return match?.[1] === undefined ? undefined : xmlText(match[1]);
}

function decodeYouTube(text: string): DecodedDelivery {
  // The hub delivers a small Atom document. Declarations are never needed, so they
  // are rejected rather than expanded.
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || !/<feed[\s>]/.test(text)) malformed("youtube");
  const items: DecodedItem[] = [];
  const accountIds: string[] = [];
  const videos: JsonObject[] = [];
  const deleted: JsonObject[] = [];

  for (const match of text.matchAll(/<entry[\s>][\s\S]*?<\/entry>/g)) {
    const block = match[0];
    const videoId = xmlElement(block, "yt:videoId");
    const channelId = xmlElement(block, "yt:channelId");

    if (!videoId || !channelId) malformed("youtube");
    const title = xmlElement(block, "title");
    const published = xmlElement(block, "published");
    const updated = xmlElement(block, "updated");

    const video: JsonObject = {
      videoId,
      channelId,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- absent Atom fields stay absent.
      ...(title === undefined ? {} : { title }),
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- absent Atom fields stay absent.
      ...(published === undefined ? {} : { published }),
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- absent Atom fields stay absent.
      ...(updated === undefined ? {} : { updated }),
    };

    accountIds.push(channelId);
    videos.push(video);
    items.push({ originalType: "yt:video", type: "unknown" });
  }

  // Atom tombstones (RFC 6721). YouTube's guide does not list deletion as a trigger,
  // so this only decodes a tombstone if the hub sends one.
  for (const match of text.matchAll(
    /<at:deleted-entry(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/at:deleted-entry>)/g,
  )) {
    const attributes = match[1] ?? "";
    const ref = xmlAttribute(attributes, "ref");
    const videoId = ref?.startsWith("yt:video:") ? ref.slice("yt:video:".length) : undefined;

    if (!videoId) malformed("youtube");
    const when = xmlAttribute(attributes, "when");
    const uri = xmlElement(match[2] ?? "", "uri");
    const channelId = uri === undefined ? undefined : /\/channel\/([\w-]+)$/.exec(uri)?.[1];

    if (channelId) accountIds.push(channelId);

    deleted.push({
      videoId,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- absent tombstone fields stay absent.
      ...(when ? { deletedAt: when } : {}),
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- absent tombstone fields stay absent.
      ...(channelId ? { channelId } : {}),
    });
    items.push({ originalType: "at:deleted-entry", type: "post.removed" });
  }

  if (items.length === 0) malformed("youtube");

  return { items, accountIds, data: { videos, deleted } };
}

function decodeLinkedIn(payload: Record<string, unknown>): DecodedDelivery {
  const kind = string(payload["type"]);
  const items: DecodedItem[] = [];
  const accountIds: string[] = [];
  let lastModifiedAt: number | undefined;

  if (kind === "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS" && payload["notifications"] !== undefined)
    for (const value of array(payload["notifications"])) {
      const notification = object(value);
      const action = string(notification["action"]);
      const organization = optionalString(notification["organizationalEntity"]);
      const modified = notification["lastModifiedAt"];

      if (organization) accountIds.push(organization);

      if (typeof modified === "number" && Number.isSafeInteger(modified) && modified > 0)
        lastModifiedAt = Math.max(lastModifiedAt ?? 0, modified);

      // Only a member comment is clearly an inbound comment. ADMIN_COMMENT is the
      // page's own comment, and edits, deletions, likes, shares, and mentions have no
      // normalized type, so they stay `unknown` with the action as originalType.
      items.push({
        originalType: action,
        type: action === "COMMENT" ? "comment.received" : "unknown",
      });
    }

  if (items.length === 0) items.push({ originalType: kind, type: "unknown" });

  return {
    items,
    accountIds,
    data: payload,
    occurredAt: lastModifiedAt === undefined ? undefined : new Date(lastModifiedAt).toISOString(),
  };
}

function tiktokEventType(event: string): SocialEvent["type"] {
  if (event === "authorization.removed") return "account.updated";

  if (
    event.startsWith("post.publish.") ||
    event === "video.upload.failed" ||
    event === "video.publish.completed"
  )
    return "publication.updated";

  return "unknown";
}

function decodeTikTok(payload: Record<string, unknown>): DecodedDelivery {
  const event = string(payload["event"]);
  const createTime = payload["create_time"];
  const rawContent = payload["content"];
  let content: unknown = rawContent;

  // TikTok sends `content` as a serialized JSON string.
  if (typeof rawContent === "string")
    try {
      content = parseJson(rawContent);
    } catch {
      content = rawContent;
    }

  const publishId =
    typeof content === "object" && content !== null && !Array.isArray(content)
      ? optionalString(object(content)["publish_id"])
      : undefined;

  const openId = optionalString(payload["user_openid"]);

  return {
    items: [{ originalType: event, type: tiktokEventType(event) }],
    accountIds: openId ? [openId] : [],
    data: { ...payload, content },
    backendRecordId: event.startsWith("post.publish.") ? publishId : undefined,
    occurredAt:
      typeof createTime === "number" && Number.isSafeInteger(createTime) && createTime > 0
        ? new Date(createTime * 1000).toISOString()
        : undefined,
  };
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeDelivery(platform: DirectWebhookPlatform, text: string): DecodedDelivery {
  if (platform === "youtube") return decodeYouTube(text);
  const payload = object(parseJson(text));

  if (platform === "instagram") return decodeInstagram(payload);

  if (platform === "threads") return decodeThreads(payload);

  if (platform === "x") return decodeX(payload);

  if (platform === "linkedin") return decodeLinkedIn(payload);

  return decodeTikTok(payload);
}

/**
 * Decode a verified direct-platform delivery into one normalized event. A single
 * delivery can batch several notifications (Meta batches up to 1000 updates); the
 * event keeps them all in `data` and reports a specific `type` only when every
 * notification maps to the same type. None of these platforms sends a delivery ID,
 * so identity is always an exact-body digest.
 */
export async function decodePlatformWebhook(input: {
  platform: DirectWebhookPlatform;
  backend: string;
  body: Uint8Array;
  receivedAt?: string;
  maxBytes?: number;
}): Promise<SocialEvent> {
  const bytes = checkedBytes(input.body, input.maxBytes ?? defaultMaxBytes);
  let delivery: DecodedDelivery;

  try {
    delivery = decodeDelivery(
      input.platform,
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (error) {
    if (error instanceof SocialError) throw error;
    malformed(input.platform);
  }

  const types = [...new Set(delivery.items.map((item) => item.type))];
  const originalTypes = [...new Set(delivery.items.map((item) => item.originalType))];
  const cleaned = clean(delivery.data);

  if (!isJsonObject(cleaned)) malformed(input.platform);

  const id = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  const event: SocialEvent = {
    version: 1,
    id,
    identity: "body-digest",
    backend: input.backend,
    provider: input.platform,
    type: types.length === 1 && types[0] !== undefined ? types[0] : "unknown",
    originalType: originalTypes.length === 0 ? "unknown" : originalTypes.join(","),
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    accountIds: [...new Set(delivery.accountIds)],
    data: cleaned,
  };

  const withRecord =
    delivery.backendRecordId === undefined
      ? event
      : { ...event, backendRecordId: delivery.backendRecordId };

  return delivery.occurredAt === undefined
    ? withRecord
    : { ...withRecord, occurredAt: delivery.occurredAt };
}
