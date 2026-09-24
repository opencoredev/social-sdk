import { SocialError, type SocialErrorCode } from "../core/errors.js";
import { definedFields } from "../core/fields.js";
import { connectedAccountRef, type JsonObject, type JsonValue } from "../core/types.js";
import { isJsonValue } from "../transport/json.js";
import {
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  type JsonField,
} from "../transport/validation.js";
import type { ConnectionAccount, ConnectionAttempt, ConnectionProvider } from "./connections.js";
import { egressBlockReason } from "./egress.js";
import { readBounded, validateCallback } from "./oauth-internal.js";

// AT Protocol OAuth profile: https://atproto.com/specs/oauth (accessed 2026-09-24).
// Handle resolution: https://atproto.com/specs/handle (accessed 2026-09-24).
// DID resolution: https://atproto.com/specs/did (accessed 2026-09-24).

const DEFAULT_SCOPE = "atproto transition:generic";

const DEFAULT_PLC_DIRECTORY = "https://plc.directory";

const DEFAULT_TIMEOUT_MS = 10_000;

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Redirect hops allowed for the HTTPS handle method. Metadata requests allow none. */
const MAX_HANDLE_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Members that only appear in private or symmetric JWKs. */
const SECRET_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;

const P256_COORDINATE = /^[A-Za-z0-9_-]{43}$/;

const JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

const EC_KEY = { name: "ECDSA", namedCurve: "P-256" } as const;

const EC_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

const HANDLE_PATTERN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

const DID_PATTERN = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;

const PLC_PATTERN = /^did:plc:[a-z2-7]{24}$/;

/** Reserved TLDs that pass handle syntax but must fail resolution. */
const DISALLOWED_TLDS = new Set([
  "alt",
  "arpa",
  "example",
  "internal",
  "invalid",
  "local",
  "localhost",
  "onion",
]);

/** ES256 client signing key for confidential clients (`private_key_jwt`). */
export interface BlueskyOAuthSigningKey {
  /** Key ID published in the client metadata `jwks` or `jwks_uri`. */
  readonly kid: string;
  /** Private P-256 JWK. Keep it in a server-side secret store. */
  readonly privateJwk: JsonWebKey;
}

export interface BlueskyOAuthRequestOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Maximum time for one HTTP request or DNS lookup. Defaults to ten seconds. */
  readonly timeoutMs?: number;
  /** Maximum response body size. Defaults to one MiB. */
  readonly maxResponseBytes?: number;
  /**
   * DNS TXT lookup used for `_atproto.<handle>`. Defaults to `resolveTxt` from
   * `node:dns/promises`, loaded on first use.
   */
  readonly resolveTxt?: (hostname: string) => Promise<readonly (readonly string[])[]>;
  /** PLC directory used for `did:plc` documents. Defaults to https://plc.directory. */
  readonly plcDirectoryUrl?: string;
  /**
   * Extra check run before every outgoing request and every redirect hop, after
   * the built-in checks. The built-in checks allow only HTTPS, reject `localhost`
   * names, and reject IP-literal hosts in loopback, private, link-local, CGNAT,
   * multicast, and reserved ranges. They cannot see where a hostname resolves.
   * Throw to block the request. For DNS-level protection, also pass a `fetch`
   * that pins resolved addresses, since a lookup here can differ from the one
   * `fetch` makes.
   */
  readonly assertEgressAllowed?: (url: URL) => void | Promise<void>;
}

export interface BlueskyOAuthClientOptions extends BlueskyOAuthRequestOptions {
  /** URL of the client metadata document, or a `http://localhost` development client ID. */
  readonly clientId: string;
  /** Present for confidential clients. Public clients omit it. */
  readonly clientKey?: BlueskyOAuthSigningKey;
}

/** A DPoP-bound AT Protocol OAuth session. Contains secrets; store it encrypted. */
export interface BlueskyOAuthSession {
  readonly version: 1;
  readonly did: string;
  readonly handle?: string;
  /** Verified PDS origin. XRPC requests go here. */
  readonly pdsUrl: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly authMethod: "none" | "private_key_jwt";
  readonly clientKeyId?: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly scopes: readonly string[];
  /** Private P-256 DPoP key bound to this session's tokens. */
  readonly dpopKey: JsonWebKey;
}

export interface BlueskyOAuthSessionSink {
  save(input: {
    readonly account: ConnectionAccount;
    readonly session: BlueskyOAuthSession;
    readonly attempt: ConnectionAttempt;
  }): Promise<void>;
}

export interface BlueskyOAuthOptions extends BlueskyOAuthClientOptions {
  readonly redirectUri?: string;
  /** Space-separated scopes. Must include `atproto`. Defaults to `atproto transition:generic`. */
  readonly scope?: string;
  /**
   * Handle, DID, or HTTPS server URL used when `ConnectionManager.begin` has no
   * `loginHint`. For example `https://bsky.social`.
   */
  readonly defaultServer?: string;
  /** Receives the verified session. Without a sink the session is discarded. */
  readonly sessionSink?: BlueskyOAuthSessionSink;
}

export interface BlueskyOAuthTransport {
  readonly did: string;
  /** Verified PDS origin, suitable for the adapter's `auth.service`. */
  readonly service: string;
  fetchHandler(pathname: string, init?: RequestInit): Promise<Response>;
}

export interface BlueskyOAuthClientMetadataInput {
  /** HTTPS URL where this document is served. */
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  /** Every scope the client may request. Must include `atproto`. */
  readonly scope: string;
  readonly applicationType?: "web" | "native";
  readonly clientName?: string;
  readonly clientUri?: string;
  readonly logoUri?: string;
  readonly tosUri?: string;
  readonly policyUri?: string;
  /** Confidential clients publish exactly one of `jwksUri` or `jwks`. */
  readonly jwksUri?: string;
  readonly jwks?: { readonly keys: readonly BlueskyOAuthPublishedJwk[] };
}

/** A public signing key in the client metadata `jwks` document. */
export type BlueskyOAuthPublishedJwk = JsonWebKey & { readonly kid?: string };

export interface BlueskyOAuthClientMetadata {
  readonly client_id: string;
  readonly application_type: "web" | "native";
  readonly grant_types: readonly ["authorization_code", "refresh_token"];
  readonly response_types: readonly ["code"];
  readonly scope: string;
  readonly redirect_uris: readonly string[];
  readonly dpop_bound_access_tokens: true;
  readonly token_endpoint_auth_method: "none" | "private_key_jwt";
  readonly token_endpoint_auth_signing_alg?: "ES256";
  readonly jwks_uri?: string;
  readonly jwks?: { readonly keys: readonly JsonWebKey[] };
  readonly client_name?: string;
  readonly client_uri?: string;
  readonly logo_uri?: string;
  readonly tos_uri?: string;
  readonly policy_uri?: string;
}

interface AuthorizationServer {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly parEndpoint: string;
  readonly revocationEndpoint?: string;
}

interface ProviderState {
  readonly version: 1;
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly dpopKey: JsonWebKey;
  readonly dpopNonce?: string;
  readonly did?: string;
  readonly handle?: string;
}

interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

type LoginTarget =
  | { readonly kind: "handle"; readonly handle: string; readonly hint: string }
  | { readonly kind: "did"; readonly did: string; readonly hint: string }
  | { readonly kind: "server"; readonly origin: string };

interface DidDocument {
  readonly pds: string;
  readonly handle?: string;
}

function fail(
  operation: string,
  message: string,
  code: SocialErrorCode = "upstream_failure",
): never {
  throw new SocialError({ code, operation, message });
}

function isOptionalString(value: JsonField): value is string | undefined {
  return value === undefined || isString(value);
}

function stringList(value: JsonField): readonly string[] {
  return isJsonArray(value) ? value.filter(isString) : [];
}

/**
 * Plain `JSON.parse`, checked against the JSON grammar. Throws a `SyntaxError`
 * for malformed text; callers map it to their own error.
 */
function parseJsonValue(text: string): JsonValue {
  const parsed: unknown = JSON.parse(text);

  if (!isJsonValue(parsed)) throw new SyntaxError("Expected a JSON value");

  return parsed;
}

function scopeTokens(scope: string): readonly string[] {
  return scope.split(" ").filter(Boolean);
}

function checkScope(scope: string, operation: string): string {
  const tokens = scopeTokens(scope);

  if (tokens.length === 0 || scope !== tokens.join(" ") || !tokens.includes("atproto"))
    fail(
      operation,
      "Bluesky OAuth scope must be space-separated and include atproto",
      "invalid_config",
    );

  return scope;
}

// Encoding and signing ----------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlJson(value: JsonObject): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  return base64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

  return base64Url(new Uint8Array(digest));
}

/** Public members of a P-256 key, as published in JWT headers and `jwks`. */
type PublicEcJwk = {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
};

function isPrivateEcJwk(value: JsonWebKey | JsonField): value is JsonWebKey {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "kty" in value &&
    value.kty === "EC" &&
    "crv" in value &&
    value.crv === "P-256" &&
    "x" in value &&
    typeof value.x === "string" &&
    "y" in value &&
    typeof value.y === "string" &&
    "d" in value &&
    typeof value.d === "string"
  );
}

function publicPart(jwk: JsonWebKey): PublicEcJwk {
  return { kty: "EC", crv: "P-256", x: jwk.x ?? "", y: jwk.y ?? "" };
}

async function importPrivateKey(jwk: JsonWebKey, operation: string): Promise<CryptoKey> {
  if (!isPrivateEcJwk(jwk))
    fail(operation, "Bluesky OAuth keys must be private P-256 JWKs", "invalid_config");

  try {
    return await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x ?? "", y: jwk.y ?? "", d: jwk.d ?? "" },
      EC_KEY,
      false,
      ["sign"],
    );
  } catch {
    fail(operation, "Bluesky OAuth key could not be imported", "invalid_config");
  }
}

async function signJwt(
  header: JsonObject,
  payload: JsonObject,
  jwk: JsonWebKey,
  operation: string,
): Promise<string> {
  const key = await importPrivateKey(jwk, operation);
  const input = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = await crypto.subtle.sign(EC_SIGN, key, new TextEncoder().encode(input));

  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

async function generateDpopKey(): Promise<JsonWebKey> {
  const pair = await crypto.subtle.generateKey(EC_KEY, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

  return { kty: "EC", crv: "P-256", x: jwk.x ?? "", y: jwk.y ?? "", d: jwk.d ?? "" };
}

/** Strip query and fragment, as RFC 9449 requires for `htu`. */
function htu(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

async function dpopProof(input: {
  readonly key: JsonWebKey;
  readonly method: string;
  readonly url: URL;
  readonly nonce: string | undefined;
  readonly accessToken?: string;
}): Promise<string> {
  const ath =
    input.accessToken === undefined ? undefined : await sha256Base64Url(input.accessToken);

  const payload = {
    jti: randomId(),
    htm: input.method.toUpperCase(),
    htu: htu(input.url),
    iat: Math.floor(Date.now() / 1000),
    ...definedFields({ nonce: input.nonce, ath }),
  };

  return signJwt(
    { typ: "dpop+jwt", alg: "ES256", jwk: publicPart(input.key) },
    payload,
    input.key,
    "bluesky.oauth.dpop",
  );
}

/** Public JWK for the client metadata `jwks` document. Never publish the private key. */
export function blueskyOAuthPublicJwk(key: BlueskyOAuthSigningKey): JsonWebKey & {
  readonly kid: string;
  readonly alg: "ES256";
  readonly use: "sig";
} {
  if (!isPrivateEcJwk(key.privateJwk) || !key.kid.trim())
    fail(
      "bluesky.oauth.config",
      "Bluesky OAuth client key must be a P-256 JWK with a kid",
      "invalid_config",
    );

  return { ...publicPart(key.privateJwk), kid: key.kid, alg: "ES256", use: "sig" };
}

// HTTP ---------------------------------------------------------------------------------

async function assertEgress(
  url: URL,
  operation: string,
  hook: ((url: URL) => void | Promise<void>) | undefined,
): Promise<void> {
  const reason = egressBlockReason(url);

  if (reason !== undefined)
    fail(operation, `Bluesky OAuth request target is not allowed: ${reason}`, "unauthorized");

  if (hook === undefined) return;

  try {
    await hook(new URL(url));
  } catch (error) {
    if (error instanceof SocialError) throw error;

    throw new SocialError({
      code: "unauthorized",
      operation,
      message: "Bluesky OAuth request target was rejected by assertEgressAllowed",
      cause: error,
    });
  }
}

/**
 * Send one request through the egress guard. Redirects are never followed by
 * `fetch`; up to `maxRedirects` GET redirects are followed here, and every hop
 * passes the same guard. With `maxRedirects` 0 a redirect is returned as is and
 * the caller rejects it as a non-success status.
 */
async function send(
  url: URL,
  init: RequestInit,
  operation: string,
  options: BlueskyOAuthRequestOptions,
  maxRedirects = 0,
): Promise<HttpResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    fail("bluesky.oauth.config", "timeoutMs must be a positive safe integer", "invalid_config");

  const fetcher = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DOMException("Bluesky OAuth request timed out", "AbortError"));
    }, timeoutMs);
  });

  const race = <T>(work: Promise<T>): Promise<T> => Promise.race([work, timeout]);

  try {
    let target = url;

    for (let hop = 0; ; hop++) {
      await race(assertEgress(target, operation, options.assertEgressAllowed));

      const response = await race(
        fetcher(target.toString(), { ...init, redirect: "manual", signal: controller.signal }),
      );

      if (maxRedirects > 0 && REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);

        if (hop >= maxRedirects) fail(operation, "Bluesky OAuth request redirected too many times");
        const location = response.headers.get("location");

        if (location === null) fail(operation, "Bluesky OAuth redirect has no Location header");

        try {
          target = new URL(location, target);
        } catch {
          fail(operation, "Bluesky OAuth redirect has an invalid Location header");
        }

        continue;
      }

      const text = await race(
        readBounded(response, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, operation),
      );

      return { status: response.status, headers: response.headers, text };
    }
  } catch (error) {
    if (error instanceof SocialError) throw error;

    if (error instanceof DOMException && error.name === "AbortError")
      fail(operation, "Bluesky OAuth request timed out", "timeout");

    throw new SocialError({
      code: "upstream_failure",
      operation,
      message: "Bluesky OAuth request failed",
      cause: error,
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseJson(text: string, operation: string): JsonObject {
  let parsed: JsonValue;

  try {
    parsed = parseJsonValue(text);
  } catch {
    fail(operation, "Bluesky OAuth server returned malformed JSON");
  }

  if (!isJsonObject(parsed)) fail(operation, "Bluesky OAuth server returned an invalid response");

  return parsed;
}

/** Metadata and identity documents must be exactly HTTP 200 JSON objects. */
async function getJson(
  url: URL,
  operation: string,
  options: BlueskyOAuthRequestOptions,
): Promise<JsonObject> {
  const result = await send(url, { headers: { accept: "application/json" } }, operation, options);

  if (result.status !== 200)
    throw new SocialError({
      code: result.status === 404 ? "not_found" : "upstream_failure",
      operation,
      message: "Bluesky OAuth discovery request failed",
      upstreamStatus: result.status,
    });

  return parseJson(result.text, operation);
}

function httpsOrigin(value: JsonField, operation: string, message: string): string {
  if (!isString(value)) fail(operation, message);
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    fail(operation, message);
  }

  // Compare the raw value so a default port, path, query, or trailing slash is rejected.
  if (url.protocol !== "https:" || url.username || url.password || value !== url.origin)
    fail(operation, message);

  return url.origin;
}

function httpsUrl(value: JsonField, operation: string, field: string): string {
  if (!isString(value)) fail(operation, `Authorization server metadata is missing ${field}`);
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    fail(operation, `Authorization server metadata has an invalid ${field}`);
  }

  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    fail(operation, `Authorization server metadata has an invalid ${field}`);

  return url.toString();
}

// Identity ---------------------------------------------------------------------------------

function isHandle(value: string): boolean {
  if (value.length > 253 || !HANDLE_PATTERN.test(value)) return false;
  const tld = value.slice(value.lastIndexOf(".") + 1);

  return !DISALLOWED_TLDS.has(tld);
}

function validDid(value: string): boolean {
  if (value.length > 2048 || !DID_PATTERN.test(value)) return false;

  if (value.startsWith("did:plc:")) return PLC_PATTERN.test(value);

  if (value.startsWith("did:web:")) return isHandle(value.slice("did:web:".length));

  return false;
}

function parseLoginTarget(raw: string): LoginTarget {
  const hint = raw.trim();

  if (hint.startsWith("https://")) {
    let url: URL;

    try {
      url = new URL(hint);
    } catch {
      fail("connections.begin", "Bluesky server URL is invalid", "invalid_input");
    }

    if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
      fail("connections.begin", "Bluesky server URL must be an HTTPS origin", "invalid_input");

    return { kind: "server", origin: url.origin };
  }

  if (hint.startsWith("did:")) {
    if (!validDid(hint))
      fail("connections.begin", "Bluesky DID must be a valid did:plc or did:web", "invalid_input");

    return { kind: "did", did: hint, hint };
  }

  const handle = (hint.startsWith("@") ? hint.slice(1) : hint).toLowerCase();

  if (!isHandle(handle))
    fail(
      "connections.begin",
      "Bluesky login hint must be a handle, DID, or HTTPS server URL",
      "invalid_input",
    );

  return { kind: "handle", handle, hint };
}

async function defaultResolveTxt(hostname: string): Promise<readonly (readonly string[])[]> {
  const dns = await import("node:dns/promises");

  return dns.resolveTxt(hostname);
}

async function withTimeout<T>(work: Promise<T>, options: BlueskyOAuthRequestOptions): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DOMException("Handle lookup timed out", "AbortError")),
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Resolve a handle with DNS TXT first, then the HTTPS well-known endpoint. */
async function resolveHandle(handle: string, options: BlueskyOAuthRequestOptions): Promise<string> {
  const operation = "bluesky.oauth.identity";
  let records: readonly (readonly string[])[] = [];

  try {
    records = await withTimeout(
      (options.resolveTxt ?? defaultResolveTxt)(`_atproto.${handle}`),
      options,
    );
  } catch {
    // No usable DNS record; fall through to the HTTPS method.
  }

  const dnsDids = [
    ...new Set(
      records
        .map((chunks) => chunks.join(""))
        .filter((value) => value.startsWith("did="))
        .map((value) => value.slice(4)),
    ),
  ];

  if (dnsDids.length > 1) fail(operation, "Bluesky handle has conflicting DNS records");
  const [dnsDid] = dnsDids;

  if (dnsDid !== undefined) {
    if (!validDid(dnsDid)) fail(operation, "Bluesky handle resolved to an unsupported DID");

    return dnsDid;
  }

  const result = await send(
    new URL(`https://${handle}/.well-known/atproto-did`),
    { headers: { accept: "text/plain" } },
    operation,
    options,
    // The handle spec allows redirects here; every hop passes the egress guard.
    // Metadata documents must not redirect.
    MAX_HANDLE_REDIRECTS,
  );

  const did = result.text.trim();

  if (result.status < 200 || result.status > 299 || !validDid(did))
    fail(operation, "Bluesky handle could not be resolved");

  return did;
}

function matchesFragment(id: JsonField, did: string, fragment: string): boolean {
  return id === fragment || id === `${did}${fragment}`;
}

async function resolveDidDocument(
  did: string,
  options: BlueskyOAuthRequestOptions,
): Promise<DidDocument> {
  const operation = "bluesky.oauth.identity";
  let url: URL;

  if (did.startsWith("did:plc:")) {
    const directory = httpsOrigin(
      options.plcDirectoryUrl ?? DEFAULT_PLC_DIRECTORY,
      "bluesky.oauth.config",
      "plcDirectoryUrl must be an HTTPS origin",
    );

    url = new URL(`/${did}`, directory);
  } else {
    url = new URL(`https://${did.slice("did:web:".length)}/.well-known/did.json`);
  }

  const doc = await getJson(url, operation, options);

  if (doc["id"] !== did)
    fail(operation, "DID document does not match the requested DID", "unauthorized");

  const services = doc["service"];

  const service = (isJsonArray(services) ? services : [])
    .filter(isJsonObject)
    .find(
      (entry) =>
        matchesFragment(entry["id"], did, "#atproto_pds") &&
        entry["type"] === "AtprotoPersonalDataServer",
    );

  if (service === undefined) fail(operation, "DID document does not name a PDS");

  const endpoint = service["serviceEndpoint"];

  const pds = httpsOrigin(
    isString(endpoint) ? endpoint.replace(/\/$/, "") : endpoint,
    operation,
    "DID document has an invalid PDS endpoint",
  );

  const handle = stringList(doc["alsoKnownAs"])
    .filter((aka) => aka.startsWith("at://"))
    .map((aka) => aka.slice("at://".length).toLowerCase())
    .find(isHandle);

  return handle === undefined ? { pds } : { pds, handle };
}

/** Read the PDS's protected-resource metadata and return its single authorization server. */
async function authorizationServerForPds(
  pds: string,
  options: BlueskyOAuthRequestOptions,
): Promise<string> {
  const operation = "bluesky.oauth.discovery";

  const metadata = await getJson(
    new URL("/.well-known/oauth-protected-resource", pds),
    operation,
    options,
  );

  const resource = metadata["resource"];

  if (resource !== undefined && (!isString(resource) || resource.replace(/\/$/, "") !== pds))
    fail(operation, "Protected resource metadata does not match the PDS", "unauthorized");

  const servers = metadata["authorization_servers"];

  if (!Array.isArray(servers) || servers.length !== 1)
    fail(operation, "Protected resource metadata must name exactly one authorization server");

  return httpsOrigin(servers[0], operation, "Protected resource metadata has an invalid issuer");
}

function includes(metadata: JsonObject, field: string, value: string): boolean {
  return stringList(metadata[field]).includes(value);
}

async function authorizationServerMetadata(
  issuer: string,
  authMethod: "none" | "private_key_jwt",
  options: BlueskyOAuthRequestOptions,
): Promise<AuthorizationServer> {
  const operation = "bluesky.oauth.discovery";

  const metadata = await getJson(
    new URL("/.well-known/oauth-authorization-server", issuer),
    operation,
    options,
  );

  if (metadata["issuer"] !== issuer)
    fail(operation, "Authorization server issuer does not match its metadata URL", "unauthorized");

  const signingAlgs = metadata["token_endpoint_auth_signing_alg_values_supported"];

  const compliant =
    includes(metadata, "response_types_supported", "code") &&
    includes(metadata, "grant_types_supported", "authorization_code") &&
    includes(metadata, "grant_types_supported", "refresh_token") &&
    includes(metadata, "code_challenge_methods_supported", "S256") &&
    includes(metadata, "token_endpoint_auth_methods_supported", authMethod) &&
    (authMethod === "none" ||
      signingAlgs === undefined ||
      includes(metadata, "token_endpoint_auth_signing_alg_values_supported", "ES256")) &&
    includes(metadata, "scopes_supported", "atproto") &&
    includes(metadata, "dpop_signing_alg_values_supported", "ES256") &&
    metadata["authorization_response_iss_parameter_supported"] === true &&
    metadata["require_pushed_authorization_requests"] === true &&
    metadata["client_id_metadata_document_supported"] === true &&
    metadata["require_request_uri_registration"] !== false;

  if (!compliant)
    fail(operation, "Authorization server metadata does not meet the AT Protocol OAuth profile");

  const revocationEndpoint = metadata["revocation_endpoint"];

  return {
    issuer,
    authorizationEndpoint: httpsUrl(
      metadata["authorization_endpoint"],
      operation,
      "authorization_endpoint",
    ),
    tokenEndpoint: httpsUrl(metadata["token_endpoint"], operation, "token_endpoint"),
    parEndpoint: httpsUrl(
      metadata["pushed_authorization_request_endpoint"],
      operation,
      "pushed_authorization_request_endpoint",
    ),
    ...definedFields({
      revocationEndpoint:
        revocationEndpoint === undefined
          ? undefined
          : httpsUrl(revocationEndpoint, operation, "revocation_endpoint"),
    }),
  };
}

/** Resolve a DID to its PDS and confirm the PDS names the expected issuer. */
async function verifyIssuerForDid(
  did: string,
  issuer: string,
  options: BlueskyOAuthRequestOptions,
): Promise<DidDocument> {
  const doc = await resolveDidDocument(did, options);
  const actual = await authorizationServerForPds(doc.pds, options);

  if (actual !== issuer)
    fail(
      "bluesky.oauth.identity",
      "Account's authorization server does not match the token issuer",
      "unauthorized",
    );

  return doc;
}

// Client configuration -------------------------------------------------------------------

function authMethodFor(options: BlueskyOAuthClientOptions): "none" | "private_key_jwt" {
  const operation = "bluesky.oauth.config";
  let url: URL;

  try {
    url = new URL(options.clientId);
  } catch {
    fail(operation, "Bluesky OAuth clientId must be a URL", "invalid_config");
  }

  const loopback = url.protocol === "http:" && url.hostname === "localhost";

  if (
    url.username ||
    url.password ||
    url.hash ||
    (loopback ? url.port !== "" || url.pathname !== "/" : url.protocol !== "https:")
  )
    fail(
      operation,
      "Bluesky OAuth clientId must be an HTTPS metadata URL or an http://localhost development client",
      "invalid_config",
    );

  if (options.clientKey === undefined) return "none";

  if (loopback)
    fail(operation, "Localhost development clients are always public clients", "invalid_config");
  blueskyOAuthPublicJwk(options.clientKey);

  return "private_key_jwt";
}

async function clientAuthentication(
  options: BlueskyOAuthClientOptions,
  issuer: string,
): Promise<Record<string, string>> {
  if (options.clientKey === undefined) return { client_id: options.clientId };
  const now = Math.floor(Date.now() / 1000);

  const assertion = await signJwt(
    { typ: "JWT", alg: "ES256", kid: options.clientKey.kid },
    {
      iss: options.clientId,
      sub: options.clientId,
      aud: issuer,
      jti: randomId(),
      iat: now,
      exp: now + 60,
    },
    options.clientKey.privateJwk,
    "bluesky.oauth.client-auth",
  );

  return {
    client_id: options.clientId,
    client_assertion_type: JWT_BEARER,
    client_assertion: assertion,
  };
}

function oauthError(status: number, text: string, operation: string): never {
  let upstreamCode: string | undefined;

  try {
    const parsed = parseJsonValue(text);
    const error = isJsonObject(parsed) ? parsed["error"] : undefined;

    if (isString(error) && error.length <= 64) upstreamCode = error;
  } catch {
    // Keep the HTTP classification when the error body is not JSON.
  }

  const code: SocialErrorCode =
    upstreamCode === "invalid_grant" || status === 401
      ? "reconnect_required"
      : upstreamCode === "access_denied"
        ? "cancelled"
        : upstreamCode === "invalid_client"
          ? "invalid_config"
          : status === 403
            ? "missing_permission"
            : status === 429
              ? "rate_limited"
              : "upstream_failure";

  const message = "Bluesky authorization server rejected the request";

  if (code === "rate_limited")
    throw new SocialError({
      code,
      operation,
      message,
      upstreamStatus: status,
      ...definedFields({ upstreamCode }),
      retryDisposition: { kind: "after-delay", delayMs: 1000 },
    });

  throw new SocialError({
    code,
    operation,
    message,
    upstreamStatus: status,
    ...definedFields({ upstreamCode }),
  });
}

function isUseDpopNonce(result: HttpResult): boolean {
  if (result.status !== 400) return false;

  try {
    const parsed = parseJsonValue(result.text);

    return isJsonObject(parsed) && parsed["error"] === "use_dpop_nonce";
  } catch {
    return false;
  }
}

interface AuthorizationServerResponse {
  readonly json: JsonObject;
  /** Latest server nonce, carried over from earlier responses when this one has none. */
  readonly nonce: string | undefined;
  /** Whether the successful response itself carried a `DPoP-Nonce` header. */
  readonly nonceReturned: boolean;
}

/**
 * The atproto OAuth profile says clients must reject responses without a
 * `DPoP-Nonce` header when the request carried DPoP. Token callers run this
 * inside the revoke-on-failure path, because the tokens were already issued.
 */
function requireServerNonce(response: AuthorizationServerResponse, operation: string): void {
  if (!response.nonceReturned)
    fail(operation, "Bluesky authorization server response is missing a DPoP-Nonce header");
}

/**
 * POST a form to an authorization server endpoint with DPoP. When the server
 * answers `use_dpop_nonce`, the request is sent once more with the new nonce, as
 * RFC 9449 section 8 requires. The server rejects that first request before
 * acting on it, so the retry cannot duplicate a grant.
 */
async function authorizationServerPost(input: {
  readonly endpoint: string;
  readonly issuer: string;
  readonly form: Readonly<Record<string, string>>;
  readonly dpopKey: JsonWebKey;
  readonly nonce: string | undefined;
  readonly operation: string;
  readonly options: BlueskyOAuthClientOptions;
}): Promise<AuthorizationServerResponse> {
  const url = new URL(input.endpoint);
  let nonce = input.nonce;

  for (let attempt = 0; ; attempt++) {
    const body = new URLSearchParams({
      ...input.form,
      ...(await clientAuthentication(input.options, input.issuer)),
    });

    const result = await send(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          DPoP: await dpopProof({ key: input.dpopKey, method: "POST", url, nonce }),
        },
        body,
      },
      input.operation,
      input.options,
    );

    const next = result.headers.get("DPoP-Nonce") ?? undefined;
    const changed = next !== undefined && next !== nonce;

    if (next !== undefined) nonce = next;

    if (attempt === 0 && changed && isUseDpopNonce(result)) continue;

    if (result.status < 200 || result.status > 299)
      oauthError(result.status, result.text, input.operation);

    return {
      json: parseJson(result.text, input.operation),
      nonce,
      nonceReturned: next !== undefined && next !== "",
    };
  }
}

/**
 * Best-effort revocation after tokens were issued but then rejected, for example
 * when identity verification fails. It sends one request and never retries,
 * including on a DPoP nonce challenge. It revokes the refresh token when there is
 * one, which ends the whole grant, and otherwise the access token. Every failure
 * is swallowed so the caller can throw its original error; the tokens never
 * appear in an error or log.
 */
async function revokeRejectedTokens(input: {
  readonly endpoint: string | undefined;
  readonly issuer: string;
  readonly tokens: IssuedTokens;
  readonly dpopKey: JsonWebKey;
  readonly nonce: string | undefined;
  readonly options: BlueskyOAuthClientOptions;
}): Promise<void> {
  const { accessToken, refreshToken } = input.tokens;

  if (input.endpoint === undefined || (accessToken === undefined && refreshToken === undefined))
    return;

  try {
    const url = new URL(input.endpoint);

    const form =
      refreshToken === undefined
        ? { token: accessToken ?? "", token_type_hint: "access_token" }
        : { token: refreshToken, token_type_hint: "refresh_token" };

    await send(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          DPoP: await dpopProof({
            key: input.dpopKey,
            method: "POST",
            url,
            nonce: input.nonce,
          }),
        },
        body: new URLSearchParams({
          ...form,
          ...(await clientAuthentication(input.options, input.issuer)),
        }),
      },
      "bluesky.oauth.revoke",
      input.options,
    );
  } catch {
    // Best effort only. The original verification error is what the caller reports.
  }
}

/**
 * Run every check that follows a token response, including parsing it; if any
 * fails, revoke the issued tokens once and rethrow the original error.
 */
async function verifyOrRevoke<T>(
  check: () => Promise<T>,
  revoke: Parameters<typeof revokeRejectedTokens>[0],
): Promise<T> {
  try {
    return await check();
  } catch (error) {
    await revokeRejectedTokens(revoke);
    throw error;
  }
}

/** Token strings pulled from a response before any other validation, so they can be revoked. */
interface IssuedTokens {
  readonly accessToken?: string;
  readonly refreshToken?: string;
}

function nonEmptyString(value: JsonField): string | undefined {
  return isString(value) && value.length > 0 ? value : undefined;
}

function issuedTokens(data: JsonObject): IssuedTokens {
  return definedFields({
    accessToken: nonEmptyString(data["access_token"]),
    refreshToken: nonEmptyString(data["refresh_token"]),
  });
}

interface TokenResponse {
  readonly did: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly scopes: readonly string[];
}

function tokenResponse(data: JsonObject, operation: string): TokenResponse {
  const accessToken = data["access_token"];
  const tokenType = data["token_type"];
  const sub = data["sub"];
  const scope = data["scope"];

  if (!isString(accessToken) || accessToken.length === 0 || accessToken.length > 16_384)
    fail(operation, "Token response is missing access_token");

  if (!isString(tokenType) || tokenType.toLowerCase() !== "dpop")
    fail(operation, "Token response is not DPoP-bound", "unauthorized");

  if (!isString(sub) || !validDid(sub))
    fail(operation, "Token response does not name a valid account DID", "unauthorized");

  if (!isString(scope) || !scopeTokens(scope).includes("atproto"))
    fail(operation, "Token response does not grant the atproto scope", "unauthorized");

  const refreshToken = data["refresh_token"];

  if (refreshToken !== undefined && (!isString(refreshToken) || refreshToken.length === 0))
    fail(operation, "Token response has an invalid refresh_token");

  const expiresIn = data["expires_in"];

  if (
    expiresIn !== undefined &&
    (!isFiniteNumber(expiresIn) || expiresIn < 0 || expiresIn > 31_536_000)
  )
    fail(operation, "Token response has an invalid lifetime");

  return {
    did: sub,
    accessToken,
    scopes: scopeTokens(scope),
    ...definedFields({
      refreshToken,
      expiresAt:
        expiresIn === undefined ? undefined : new Date(Date.now() + expiresIn * 1000).toISOString(),
    }),
  };
}

function encodeProviderState(state: ProviderState): string {
  return JSON.stringify(state);
}

function decodeProviderState(value: string | undefined): ProviderState {
  const operation = "connections.complete";

  if (value === undefined)
    fail(operation, "Bluesky OAuth attempt has no provider state", "invalid_input");
  let parsed: JsonValue;

  try {
    parsed = parseJsonValue(value);
  } catch {
    fail(operation, "Bluesky OAuth provider state is malformed", "invalid_input");
  }

  if (!isJsonObject(parsed))
    fail(operation, "Bluesky OAuth provider state is malformed", "invalid_input");

  const issuer = parsed["issuer"];
  const tokenEndpoint = parsed["tokenEndpoint"];
  const revocationEndpoint = parsed["revocationEndpoint"];
  const dpopKey = parsed["dpopKey"];
  const dpopNonce = parsed["dpopNonce"];
  const did = parsed["did"];
  const handle = parsed["handle"];

  if (
    parsed["version"] !== 1 ||
    !isString(issuer) ||
    !isString(tokenEndpoint) ||
    !isOptionalString(revocationEndpoint) ||
    !isPrivateEcJwk(dpopKey) ||
    !isOptionalString(dpopNonce) ||
    !isOptionalString(did) ||
    !isOptionalString(handle)
  )
    fail(operation, "Bluesky OAuth provider state is malformed", "invalid_input");

  return {
    version: 1,
    issuer,
    tokenEndpoint,
    dpopKey,
    ...definedFields({ revocationEndpoint, dpopNonce, did, handle }),
  };
}

async function verifiedHandle(
  did: string,
  claimed: string | undefined,
  alreadyVerified: string | undefined,
  options: BlueskyOAuthRequestOptions,
): Promise<string | undefined> {
  if (claimed === undefined) return undefined;

  if (claimed === alreadyVerified) return claimed;

  try {
    return (await resolveHandle(claimed, options)) === did ? claimed : undefined;
  } catch {
    // An unverified handle is only omitted; the DID remains the account identifier.
    return undefined;
  }
}

/**
 * AT Protocol OAuth for Bluesky accounts, driven by `ConnectionManager`.
 *
 * `start` resolves the login hint to an authorization server, generates a DPoP
 * key, and sends a pushed authorization request with the manager's PKCE
 * challenge and state. `complete` checks `iss`, exchanges the code with DPoP,
 * and verifies that the returned DID's PDS names the same issuer before the
 * account is returned or the session reaches `sessionSink`.
 */
export function blueskyOAuth(options: BlueskyOAuthOptions): ConnectionProvider {
  const authMethod = authMethodFor(options);
  const scope = checkScope(options.scope ?? DEFAULT_SCOPE, "bluesky.oauth.config");

  return {
    async start(input) {
      if (!input.platforms.includes("bluesky"))
        fail(
          "connections.begin",
          "Bluesky OAuth cannot authorize the requested platforms",
          "invalid_input",
        );

      if (options.redirectUri !== undefined && options.redirectUri !== input.redirectUri)
        fail(
          "connections.begin",
          "redirectUri does not match the configured OAuth callback",
          "invalid_input",
        );

      const hint = input.loginHint ?? options.defaultServer;

      if (hint === undefined || !hint.trim())
        fail(
          "connections.begin",
          "Bluesky OAuth needs a handle, DID, or server URL as loginHint",
          "invalid_input",
        );

      const target = parseLoginTarget(hint);
      let issuer: string;
      let did: string | undefined;
      let handle: string | undefined;

      if (target.kind === "server") {
        try {
          issuer = await authorizationServerForPds(target.origin, options);
        } catch (error) {
          // An entryway such as https://bsky.social is itself the authorization server.
          if (!(error instanceof SocialError) || error.code !== "not_found") throw error;
          issuer = target.origin;
        }
      } else {
        did = target.kind === "did" ? target.did : await resolveHandle(target.handle, options);
        const doc = await resolveDidDocument(did, options);

        if (target.kind === "handle") {
          if (doc.handle !== target.handle)
            fail(
              "bluesky.oauth.identity",
              "Bluesky handle is not confirmed by its DID document",
              "unauthorized",
            );
          handle = target.handle;
        }

        issuer = await authorizationServerForPds(doc.pds, options);
      }

      const server = await authorizationServerMetadata(issuer, authMethod, options);
      const dpopKey = await generateDpopKey();

      const par = await authorizationServerPost({
        endpoint: server.parEndpoint,
        issuer,
        form: {
          response_type: "code",
          code_challenge: input.codeChallenge,
          code_challenge_method: "S256",
          state: input.state,
          redirect_uri: input.redirectUri,
          scope,
          ...definedFields({ login_hint: target.kind === "server" ? undefined : target.hint }),
        },
        dpopKey,
        nonce: undefined,
        operation: "bluesky.oauth.par",
        options,
      });

      requireServerNonce(par, "bluesky.oauth.par");
      const requestUri = par.json["request_uri"];

      if (!isString(requestUri) || requestUri.length === 0)
        fail("bluesky.oauth.par", "Pushed authorization response is missing request_uri");

      const url = new URL(server.authorizationEndpoint);
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("request_uri", requestUri);

      return {
        authorizationUrl: url.toString(),
        providerState: encodeProviderState({
          version: 1,
          issuer,
          tokenEndpoint: server.tokenEndpoint,
          dpopKey,
          ...definedFields({
            revocationEndpoint: server.revocationEndpoint,
            dpopNonce: par.nonce,
            did,
            handle,
          }),
        }),
        // Holds the DPoP private key, so it never leaves the connection store.
        providerStateSecret: true,
      };
    },

    async complete(input) {
      const callback = validateCallback(input);
      const denied = callback.searchParams.get("error");

      if (denied !== null)
        fail(
          "connections.complete",
          "OAuth authorization was cancelled or denied",
          denied === "access_denied" ? "cancelled" : "unauthorized",
        );

      if (!input.attempt.platforms.includes("bluesky"))
        fail(
          "connections.complete",
          "Connection attempt does not include Bluesky",
          "invalid_input",
        );

      const state = decodeProviderState(input.attempt.providerState);
      const issuers = callback.searchParams.getAll("iss");

      if (issuers.length !== 1 || issuers[0] !== state.issuer)
        fail(
          "connections.complete",
          "OAuth callback issuer does not match this attempt",
          "unauthorized",
        );

      const code = callback.searchParams.get("code");

      if (!code)
        fail(
          "connections.complete",
          "OAuth callback did not include an authorization code",
          "invalid_input",
        );

      const exchanged = await authorizationServerPost({
        endpoint: state.tokenEndpoint,
        issuer: state.issuer,
        form: {
          grant_type: "authorization_code",
          code,
          redirect_uri: input.attempt.redirectUri,
          code_verifier: input.attempt.codeVerifier,
        },
        dpopKey: state.dpopKey,
        nonce: state.dpopNonce,
        operation: "bluesky.oauth.token",
        options,
      });

      const { token, doc } = await verifyOrRevoke(
        async () => {
          requireServerNonce(exchanged, "bluesky.oauth.token");
          const parsed = tokenResponse(exchanged.json, "bluesky.oauth.token");

          if (state.did !== undefined && parsed.did !== state.did)
            fail(
              "bluesky.oauth.identity",
              "Token subject does not match the requested account",
              "unauthorized",
            );

          return {
            token: parsed,
            doc: await verifyIssuerForDid(parsed.did, state.issuer, options),
          };
        },
        {
          endpoint: state.revocationEndpoint,
          issuer: state.issuer,
          tokens: issuedTokens(exchanged.json),
          dpopKey: state.dpopKey,
          nonce: exchanged.nonce,
          options,
        },
      );

      const handle = await verifiedHandle(token.did, doc.handle, state.handle, options);

      const account: ConnectionAccount = {
        ref: connectedAccountRef({
          backend: input.attempt.backend,
          platform: "bluesky",
          accountId: token.did,
        }),
        displayName: handle ?? token.did,
      };

      if (options.sessionSink !== undefined) {
        const session: BlueskyOAuthSession = {
          version: 1,
          did: token.did,
          pdsUrl: doc.pds,
          issuer: state.issuer,
          clientId: options.clientId,
          authMethod,
          accessToken: token.accessToken,
          scopes: token.scopes,
          dpopKey: state.dpopKey,
          ...definedFields({
            handle,
            clientKeyId: options.clientKey?.kid,
            refreshToken: token.refreshToken,
            expiresAt: token.expiresAt,
          }),
        };

        await options.sessionSink.save({ account, session, attempt: input.attempt });
      }

      return [account];
    },
  };
}

/**
 * Validate a session loaded from storage before using it. Pass the decoded JSON
 * document, for example the result of `JSON.parse` on the decrypted session.
 */
export function parseBlueskyOAuthSession(
  value: BlueskyOAuthSession | JsonValue,
): BlueskyOAuthSession {
  const operation = "bluesky.oauth.session";

  const invalid = (): never =>
    fail(operation, "Stored Bluesky OAuth session is invalid", "invalid_config");

  if (!isJsonValue(value) || !isJsonObject(value) || value["version"] !== 1) return invalid();
  const did = value["did"];
  const handle = value["handle"];
  const pdsUrl = value["pdsUrl"];
  const issuer = value["issuer"];
  const clientId = value["clientId"];
  const authMethod = value["authMethod"];
  const clientKeyId = value["clientKeyId"];
  const accessToken = value["accessToken"];
  const refreshToken = value["refreshToken"];
  const expiresAt = value["expiresAt"];
  const scopes = value["scopes"];
  const dpopKey = value["dpopKey"];

  if (
    !isString(did) ||
    !validDid(did) ||
    (handle !== undefined && (!isString(handle) || !isHandle(handle))) ||
    !isString(clientId) ||
    (authMethod !== "none" && authMethod !== "private_key_jwt") ||
    (authMethod === "private_key_jwt") !== isString(clientKeyId) ||
    !isOptionalString(clientKeyId) ||
    !isString(accessToken) ||
    accessToken.length === 0 ||
    (refreshToken !== undefined && (!isString(refreshToken) || refreshToken.length === 0)) ||
    (expiresAt !== undefined && (!isString(expiresAt) || Number.isNaN(Date.parse(expiresAt)))) ||
    !isJsonArray(scopes) ||
    !scopes.every(isString) ||
    !scopes.includes("atproto") ||
    !isPrivateEcJwk(dpopKey)
  )
    return invalid();

  return {
    version: 1,
    did,
    pdsUrl: httpsOrigin(pdsUrl, operation, "Stored Bluesky OAuth session is invalid"),
    issuer: httpsOrigin(issuer, operation, "Stored Bluesky OAuth session is invalid"),
    clientId,
    authMethod,
    accessToken,
    ...definedFields({ handle, clientKeyId, refreshToken, expiresAt }),
    scopes: stringList(scopes),
    dpopKey: {
      kty: "EC",
      crv: "P-256",
      x: dpopKey.x ?? "",
      y: dpopKey.y ?? "",
      d: dpopKey.d ?? "",
    },
  };
}

function replayable(body: BodyInit | null | undefined): boolean {
  return !(typeof ReadableStream !== "undefined" && body instanceof ReadableStream);
}

/**
 * DPoP transport for the Bluesky adapter's `session` option. Every request gets
 * `Authorization: DPoP <token>` and a fresh proof with `ath`. When the PDS
 * answers 401 with `use_dpop_nonce`, a replayable request is sent once more with
 * the new nonce (RFC 9449 section 9). It never refreshes tokens; call
 * `refreshBlueskyOAuthSession` before `expiresAt`.
 *
 * A PDS response without a `DPoP-Nonce` header is returned rather than rejected:
 * by then the PDS has already processed the request, and turning a completed
 * write into an error would hide its outcome.
 */
export function blueskyOAuthTransport(
  session: BlueskyOAuthSession,
  options: Pick<BlueskyOAuthRequestOptions, "fetch" | "assertEgressAllowed"> = {},
): BlueskyOAuthTransport {
  const verified = parseBlueskyOAuthSession(session);
  const fetcher = options.fetch ?? globalThis.fetch;
  let nonce: string | undefined;

  return {
    did: verified.did,
    service: verified.pdsUrl,
    async fetchHandler(pathname, init = {}) {
      if (!pathname.startsWith("/") || pathname.startsWith("//"))
        fail(
          "bluesky.oauth.transport",
          "Bluesky OAuth transport accepts only relative XRPC paths",
          "invalid_input",
        );

      const url = new URL(pathname, verified.pdsUrl);

      if (url.origin !== verified.pdsUrl)
        fail(
          "bluesky.oauth.transport",
          "Bluesky OAuth transport must target the session PDS",
          "invalid_input",
        );

      await assertEgress(url, "bluesky.oauth.transport", options.assertEgressAllowed);
      const method = (init.method ?? "GET").toUpperCase();

      const request = async (proofNonce: string | undefined): Promise<Response> => {
        const headers = new Headers(init.headers);
        headers.set("Authorization", `DPoP ${verified.accessToken}`);
        headers.set(
          "DPoP",
          await dpopProof({
            key: verified.dpopKey,
            method,
            url,
            nonce: proofNonce,
            accessToken: verified.accessToken,
          }),
        );

        return fetcher(url.toString(), { ...init, method, headers });
      };

      const sent = nonce;
      const response = await request(sent);
      const next = response.headers.get("DPoP-Nonce") ?? undefined;

      if (next !== undefined) nonce = next;

      const challenge = response.headers.get("WWW-Authenticate") ?? "";

      if (
        response.status !== 401 ||
        next === undefined ||
        next === sent ||
        !challenge.startsWith("DPoP") ||
        !challenge.includes('error="use_dpop_nonce"') ||
        !replayable(init.body)
      )
        return response;

      await response.body?.cancel();
      const retried = await request(next);
      const latest = retried.headers.get("DPoP-Nonce");

      if (latest !== null) nonce = latest;

      return retried;
    },
  };
}

/**
 * Refresh a session with its own DPoP key and client authentication. The
 * account's PDS is resolved again first, and the refresh fails unless it still
 * names the session issuer. Refresh tokens rotate, so store the result with a
 * compare-and-set write (for example `CredentialManager.rotate`).
 */
export async function refreshBlueskyOAuthSession(
  session: BlueskyOAuthSession,
  options: BlueskyOAuthClientOptions,
): Promise<BlueskyOAuthSession> {
  const operation = "bluesky.oauth.refresh";
  const current = parseBlueskyOAuthSession(session);
  const authMethod = authMethodFor(options);

  if (
    options.clientId !== current.clientId ||
    authMethod !== current.authMethod ||
    options.clientKey?.kid !== current.clientKeyId
  )
    fail(operation, "Refresh must use the session's client ID and signing key", "invalid_config");

  if (current.refreshToken === undefined)
    fail(operation, "No refresh token is available; reconnect the account", "reconnect_required");

  const doc = await verifyIssuerForDid(current.did, current.issuer, options);
  const server = await authorizationServerMetadata(current.issuer, authMethod, options);

  const refreshed = await authorizationServerPost({
    endpoint: server.tokenEndpoint,
    issuer: current.issuer,
    form: { grant_type: "refresh_token", refresh_token: current.refreshToken },
    dpopKey: current.dpopKey,
    nonce: undefined,
    operation,
    options,
  });

  const token = await verifyOrRevoke(
    async () => {
      requireServerNonce(refreshed, operation);
      const parsed = tokenResponse(refreshed.json, operation);

      if (parsed.did !== current.did)
        fail(operation, "Refreshed token belongs to a different account", "unauthorized");

      return parsed;
    },
    {
      endpoint: server.revocationEndpoint,
      issuer: current.issuer,
      tokens: issuedTokens(refreshed.json),
      dpopKey: current.dpopKey,
      nonce: refreshed.nonce,
      options,
    },
  );

  const { refreshToken: _previousRefresh, expiresAt: _previousExpiry, ...rest } = current;

  return {
    ...rest,
    pdsUrl: doc.pds,
    accessToken: token.accessToken,
    ...definedFields({ refreshToken: token.refreshToken, expiresAt: token.expiresAt }),
    scopes: token.scopes,
  };
}

// Client metadata ---------------------------------------------------------------------

function metadataUrl(value: string, field: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    fail("bluesky.oauth.metadata", `${field} must be a URL`, "invalid_config");
  }

  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    fail("bluesky.oauth.metadata", `${field} must be an HTTPS URL`, "invalid_config");

  return url;
}

function checkRedirect(value: string, clientId: URL, applicationType: "web" | "native"): string {
  const operation = "bluesky.oauth.metadata";
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    fail(operation, "redirect_uris entries must be URLs", "invalid_config");
  }

  if (url.username || url.password || url.hash)
    fail(
      operation,
      "redirect_uris entries must not contain credentials or fragments",
      "invalid_config",
    );

  if (url.protocol === "https:") {
    if (applicationType === "native" && url.origin !== clientId.origin)
      fail(
        operation,
        "Native HTTPS redirect URIs must share the client_id origin",
        "invalid_config",
      );

    return value;
  }

  const scheme = clientId.hostname.split(".").reverse().join(".");

  if (
    applicationType !== "native" ||
    url.protocol !== `${scheme}:` ||
    !value.startsWith(`${scheme}:/`) ||
    value.startsWith(`${scheme}://`)
  )
    fail(
      operation,
      "Web redirect URIs must use HTTPS; native custom schemes must be the reversed client_id hostname followed by :/",
      "invalid_config",
    );

  return value;
}

/**
 * Check one `jwks` entry and copy only its public members. Client authentication
 * uses ES256, so only EC P-256 public keys are accepted. Any private or symmetric
 * member, including an `oct` key's `k`, is rejected rather than stripped so that
 * a misplaced secret is noticed.
 */
/** Any non-array object is structurally a JWK, since every JWK member is optional. */
function isJwkObject(
  value: BlueskyOAuthPublishedJwk | JsonField,
): value is BlueskyOAuthPublishedJwk {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publishableJwk(
  value: BlueskyOAuthPublishedJwk,
  operation: string,
): BlueskyOAuthPublishedJwk {
  if (!isJwkObject(value)) fail(operation, "jwks entries must be JWK objects", "invalid_config");

  if (SECRET_JWK_MEMBERS.some((member) => member in value))
    fail(operation, "jwks must contain public keys only", "invalid_config");

  const { kty, crv, x, y, kid, alg, use } = value;

  if (
    kty !== "EC" ||
    crv !== "P-256" ||
    !isString(x) ||
    !isString(y) ||
    !P256_COORDINATE.test(x) ||
    !P256_COORDINATE.test(y)
  )
    fail(operation, "jwks keys must be EC P-256 public keys", "invalid_config");

  if (
    (kid !== undefined && (!isString(kid) || kid.length === 0)) ||
    (alg !== undefined && alg !== "ES256") ||
    (use !== undefined && use !== "sig")
  )
    fail(operation, "jwks keys must be ES256 signing keys", "invalid_config");

  return {
    kty,
    crv,
    x,
    y,
    ...definedFields({ kid, alg, use }),
  };
}

/**
 * Build and validate the client metadata document to serve at `clientId`.
 * Adding `jwks` or `jwksUri` makes the client confidential (`private_key_jwt`).
 */
export function blueskyOAuthClientMetadata(
  input: BlueskyOAuthClientMetadataInput,
): BlueskyOAuthClientMetadata {
  const operation = "bluesky.oauth.metadata";
  const clientId = metadataUrl(input.clientId, "client_id");

  if (clientId.port !== "" || clientId.pathname === "/")
    fail(
      operation,
      "client_id must be the full HTTPS URL of the metadata document, without a port",
      "invalid_config",
    );

  const applicationType = input.applicationType ?? "web";

  if (input.redirectUris.length === 0)
    fail(operation, "At least one redirect URI is required", "invalid_config");

  const redirectUris = input.redirectUris.map((uri) =>
    checkRedirect(uri, clientId, applicationType),
  );

  const scope = checkScope(input.scope, operation);

  if (input.jwks !== undefined && input.jwksUri !== undefined)
    fail(operation, "Use jwks or jwks_uri, not both", "invalid_config");

  if (input.jwks !== undefined && input.jwks.keys.length === 0)
    fail(operation, "jwks must contain at least one public key", "invalid_config");
  const jwks = input.jwks?.keys.map((key) => publishableJwk(key, operation));

  if (
    input.clientUri !== undefined &&
    metadataUrl(input.clientUri, "client_uri").hostname !== clientId.hostname
  )
    fail(operation, "client_uri must share the client_id hostname", "invalid_config");

  for (const [field, value] of [
    ["logo_uri", input.logoUri],
    ["tos_uri", input.tosUri],
    ["policy_uri", input.policyUri],
  ] as const)
    if (value !== undefined) metadataUrl(value, field);

  const jwksUri =
    input.jwksUri === undefined ? undefined : metadataUrl(input.jwksUri, "jwks_uri").toString();

  const confidential = input.jwks !== undefined || jwksUri !== undefined;
  const signingAlg: "ES256" | undefined = confidential ? "ES256" : undefined;

  return {
    client_id: input.clientId,
    application_type: applicationType,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope,
    redirect_uris: redirectUris,
    dpop_bound_access_tokens: true,
    token_endpoint_auth_method: confidential ? "private_key_jwt" : "none",
    ...definedFields({
      token_endpoint_auth_signing_alg: signingAlg,
      jwks_uri: jwksUri,
      jwks: jwks === undefined ? undefined : { keys: jwks },
      client_name: input.clientName,
      client_uri: input.clientUri,
      logo_uri: input.logoUri,
      tos_uri: input.tosUri,
      policy_uri: input.policyUri,
    }),
  };
}

/**
 * Development client ID for a public client running on a loopback address. The
 * authorization server derives its metadata from these query parameters.
 */
export function blueskyLoopbackClientId(
  input: {
    readonly redirectUris?: readonly string[];
    readonly scope?: string;
  } = {},
): string {
  const operation = "bluesky.oauth.metadata";
  const url = new URL("http://localhost");

  for (const uri of input.redirectUris ?? []) {
    let redirect: URL;

    try {
      redirect = new URL(uri);
    } catch {
      fail(operation, "Loopback redirect URIs must be URLs", "invalid_config");
    }

    if (
      redirect.protocol !== "http:" ||
      (redirect.hostname !== "127.0.0.1" && redirect.hostname !== "[::1]")
    )
      fail(
        operation,
        "Loopback redirect URIs must use http://127.0.0.1 or http://[::1]",
        "invalid_config",
      );
    url.searchParams.append("redirect_uri", uri);
  }

  if (input.scope !== undefined) url.searchParams.set("scope", checkScope(input.scope, operation));

  return url.toString();
}
