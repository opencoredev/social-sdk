/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-known-value-widening, anti-slop/no-conditional-empty-object-spread -- the mocked AT Protocol servers decode request bodies and JWTs, then assert on them. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SocialError } from "../src/core/errors.js";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";
import { bluesky } from "../src/platforms/bluesky.js";
import {
  ConnectionManager,
  MemoryConnectionStore,
  type ConnectionAttempt,
} from "../src/server/connections.js";
import {
  blueskyLoopbackClientId,
  blueskyOAuth,
  blueskyOAuthClientMetadata,
  blueskyOAuthPublicJwk,
  blueskyOAuthTransport,
  parseBlueskyOAuthSession,
  refreshBlueskyOAuthSession,
  type BlueskyOAuthSession,
  type BlueskyOAuthSigningKey,
} from "../src/server/oauth.js";
import { egressBlockReason } from "../src/server/egress.js";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const OTHER_DID = "did:plc:zyxwvutsrqponmlkjihgfedc";
const HANDLE = "alice.pds.test";
const PDS = "https://pds.test";
const ISSUER = "https://auth.test";
const PLC = "https://plc.test";
const CLIENT_ID = "https://app.test/client-metadata.json";
const REDIRECT = "https://app.test/oauth/bluesky/callback";

interface Jwt {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
}

interface Captured {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly form: URLSearchParams;
  readonly redirect: RequestRedirect | undefined;
  readonly dpop?: Jwt;
}

function decodePart(part: string): Record<string, unknown> {
  const padded = part.replaceAll("-", "+").replaceAll("_", "/");
  const text = new TextDecoder().decode(
    Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)),
  );
  return JSON.parse(text) as Record<string, unknown>;
}

function base64UrlBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/** Decode a compact JWT and verify its ES256 signature against `jwk`. */
async function verifyJwt(token: string, jwk?: JsonWebKey): Promise<Jwt> {
  const [h, p, s] = token.split(".");
  assert.ok(h && p && s, "JWT has three parts");
  const header = decodePart(h);
  const payload = decodePart(p);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk ?? (header["jwk"] as JsonWebKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64UrlBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  assert.equal(valid, true, "JWT signature verifies");
  return { header, payload };
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function asMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["ES256"],
    scopes_supported: ["atproto", "transition:generic"],
    authorization_response_iss_parameter_supported: true,
    require_pushed_authorization_requests: true,
    dpop_signing_alg_values_supported: ["ES256"],
    client_id_metadata_document_supported: true,
    require_request_uri_registration: true,
    ...overrides,
  };
}

function didDocument(did: string, pds: string, handle = HANDLE): Record<string, unknown> {
  return {
    id: did,
    alsoKnownAs: [`at://${handle}`],
    service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: pds }],
  };
}

interface WorldOptions {
  /** Issuer named by the PDS protected-resource metadata. */
  readonly pdsIssuer?: string;
  readonly tokenSub?: string;
  readonly tokenScope?: string | null;
  readonly asMetadata?: Record<string, unknown>;
  readonly entryway?: boolean;
  /** Advertise a revocation endpoint that answers this way. */
  readonly revocation?: "ok" | "server-error" | "nonce-challenge" | "network-error";
  /** Subject returned only for refresh grants. */
  readonly refreshSub?: string;
  readonly noRefreshToken?: boolean;
  /** Overrides `token_type` in token responses. */
  readonly tokenType?: string;
  /** Leave the `DPoP-Nonce` header off successful PAR or token responses. */
  readonly omitNonce?: "par" | "token";
}

/**
 * Mocked PLC directory, PDS, and authorization server. The authorization
 * server verifies every DPoP proof and demands a server nonce, like the
 * reference implementation.
 */
function world(options: WorldOptions = {}) {
  const requests: Captured[] = [];
  const asNonce = "as-nonce-1";
  const pdsNonce = "pds-nonce-1";
  const refreshTokens = new Set(["rt-1"]);
  let issued = 0;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const form = new URLSearchParams(
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body
          : "",
    );
    const proof = headers.get("DPoP");
    const dpop = proof === null ? undefined : await verifyJwt(proof);
    requests.push({
      url,
      method,
      headers,
      form,
      redirect: init?.redirect,
      ...(dpop === undefined ? {} : { dpop }),
    });

    if (url.origin === PLC) {
      if (url.pathname === `/${DID}`) return json(didDocument(DID, PDS));
      if (url.pathname === `/${OTHER_DID}`)
        return json(didDocument(OTHER_DID, "https://other-pds.test", "other.pds.test"));
      return json({ message: "not found" }, 404);
    }

    if (url.origin === PDS || url.origin === "https://other-pds.test") {
      if (url.pathname === "/.well-known/oauth-protected-resource")
        return options.entryway
          ? json({}, 404)
          : json({
              resource: url.origin,
              authorization_servers: [
                url.origin === PDS ? (options.pdsIssuer ?? ISSUER) : "https://evil-auth.test",
              ],
            });

      if (url.pathname.startsWith("/xrpc/")) {
        assert.ok(dpop, "XRPC request carries a DPoP proof");
        if (dpop.payload["nonce"] !== pdsNonce)
          return json({ error: "use_dpop_nonce" }, 401, {
            "WWW-Authenticate":
              'DPoP error="use_dpop_nonce", error_description="Resource server requires nonce"',
            "DPoP-Nonce": pdsNonce,
          });
        return json({ uri: `at://${DID}/app.bsky.feed.post/1`, cid: "bafy-cid" }, 200, {
          "DPoP-Nonce": pdsNonce,
        });
      }
    }

    if (url.origin === ISSUER) {
      if (url.pathname === "/.well-known/oauth-protected-resource") return json({}, 404);
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json(
          options.asMetadata ??
            asMetadata(
              options.revocation === undefined
                ? {}
                : { revocation_endpoint: `${ISSUER}/oauth/revoke` },
            ),
        );

      assert.ok(dpop, "authorization server request carries a DPoP proof");
      assert.equal(dpop.header["typ"], "dpop+jwt");
      assert.equal(dpop.header["alg"], "ES256");
      assert.equal(dpop.payload["htm"], "POST");
      assert.equal(dpop.payload["htu"], `${url.origin}${url.pathname}`);
      assert.equal("ath" in dpop.payload, false);
      if (url.pathname === "/oauth/revoke") {
        if (options.revocation === "network-error") throw new TypeError("connection reset");
        if (options.revocation === "server-error") return json({ error: "server_error" }, 500);
        if (options.revocation === "nonce-challenge")
          return json({ error: "use_dpop_nonce" }, 400, { "DPoP-Nonce": "as-nonce-2" });
        return new Response(null, { status: 200 });
      }

      if (dpop.payload["nonce"] !== asNonce)
        return json({ error: "use_dpop_nonce" }, 400, { "DPoP-Nonce": asNonce });

      if (url.pathname === "/oauth/par")
        return json(
          { request_uri: "urn:ietf:params:oauth:request_uri:req-1", expires_in: 299 },
          201,
          options.omitNonce === "par" ? {} : { "DPoP-Nonce": asNonce },
        );

      if (url.pathname === "/oauth/token") {
        const grant = form.get("grant_type");
        if (grant === "authorization_code" && form.get("code") !== "code-1")
          return json({ error: "invalid_grant" }, 400, { "DPoP-Nonce": asNonce });
        if (grant === "refresh_token") {
          const presented = form.get("refresh_token") ?? "";
          if (!refreshTokens.delete(presented))
            return json({ error: "invalid_grant" }, 400, { "DPoP-Nonce": asNonce });
        }
        issued++;
        refreshTokens.add(`rt-${issued + 1}`);
        return json(
          {
            access_token: `at-${issued}`,
            token_type: options.tokenType ?? "DPoP",
            ...(options.noRefreshToken ? {} : { refresh_token: `rt-${issued + 1}` }),
            expires_in: 900,
            sub:
              grant === "refresh_token"
                ? (options.refreshSub ?? options.tokenSub ?? DID)
                : (options.tokenSub ?? DID),
            ...(options.tokenScope === null
              ? {}
              : { scope: options.tokenScope ?? "atproto transition:generic" }),
          },
          200,
          options.omitNonce === "token" ? {} : { "DPoP-Nonce": asNonce },
        );
      }
    }

    return json({ message: "unexpected request" }, 500);
  };

  return { fetch, requests };
}

const resolveTxt = async (hostname: string): Promise<readonly (readonly string[])[]> => {
  assert.equal(hostname, `_atproto.${HANDLE}`);
  return [["did=", DID], ["unrelated=value"]];
};

function attemptFor(providerState: string | undefined): ConnectionAttempt {
  return {
    id: "attempt",
    backend: "direct",
    tenantId: "tenant",
    principalId: "user",
    platforms: ["bluesky"],
    capabilities: [],
    redirectUri: REDIRECT,
    state: "state-1",
    codeVerifier: "verifier-1",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...(providerState === undefined ? {} : { providerState }),
  };
}

function startInput(loginHint?: string) {
  return {
    platforms: ["bluesky"] as const,
    capabilities: [],
    redirectUri: REDIRECT,
    state: "state-1",
    codeChallenge: "challenge-1",
    ...(loginHint === undefined ? {} : { loginHint }),
  };
}

async function codeFor(error: Promise<unknown>): Promise<string> {
  try {
    await error;
  } catch (caught) {
    assert.ok(caught instanceof SocialError);
    return caught.code;
  }
  assert.fail("expected a SocialError");
}

async function signingKey(): Promise<BlueskyOAuthSigningKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return { kid: "key-1", privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

function context(): AdapterOperationContext {
  return {
    backendInstance: "direct",
    correlationId: "test",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
  };
}

describe("Bluesky AT Protocol OAuth", () => {
  it("resolves a handle, sends PAR with DPoP and nonce retry, and completes with a verified session", async () => {
    const mock = world();
    const saved: BlueskyOAuthSession[] = [];
    const provider = blueskyOAuth({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      fetch: mock.fetch,
      resolveTxt,
      plcDirectoryUrl: PLC,
      sessionSink: { save: async ({ session }) => void saved.push(session) },
    });

    const started = await provider.start(startInput(`@${HANDLE.toUpperCase()}`));
    const auth = new URL(started.authorizationUrl);
    assert.equal(`${auth.origin}${auth.pathname}`, `${ISSUER}/oauth/authorize`);
    assert.deepEqual([...auth.searchParams.keys()].sort(), ["client_id", "request_uri"]);
    assert.equal(auth.searchParams.get("client_id"), CLIENT_ID);

    const pars = mock.requests.filter((request) => request.url.pathname === "/oauth/par");
    assert.equal(pars.length, 2, "one nonce retry");
    assert.equal(pars[0]?.dpop?.payload["nonce"], undefined);
    assert.equal(pars[1]?.dpop?.payload["nonce"], "as-nonce-1");
    assert.notEqual(pars[0]?.dpop?.payload["jti"], pars[1]?.dpop?.payload["jti"]);
    const par = pars[1]?.form;
    assert.equal(par?.get("client_id"), CLIENT_ID);
    assert.equal(par?.get("response_type"), "code");
    assert.equal(par?.get("code_challenge"), "challenge-1");
    assert.equal(par?.get("code_challenge_method"), "S256");
    assert.equal(par?.get("state"), "state-1");
    assert.equal(par?.get("redirect_uri"), REDIRECT);
    assert.equal(par?.get("scope"), "atproto transition:generic");
    assert.equal(par?.get("login_hint"), `@${HANDLE.toUpperCase()}`);
    assert.equal(par?.has("client_assertion"), false);

    const providerState = started.providerState;
    assert.ok(providerState);
    assert.doesNotMatch(providerState, /at-1|rt-1|code-1/);

    const accounts = await provider.complete({
      callbackUrl: `${REDIRECT}?state=state-1&iss=${encodeURIComponent(ISSUER)}&code=code-1`,
      attempt: attemptFor(providerState),
    });
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.ref.platform, "bluesky");
    assert.equal(accounts[0]?.ref.accountId, DID);
    assert.equal(accounts[0]?.displayName, HANDLE);

    const tokens = mock.requests.filter((request) => request.url.pathname === "/oauth/token");
    assert.equal(tokens.length, 1, "stored PAR nonce avoids a second token request");
    assert.equal(tokens[0]?.form.get("grant_type"), "authorization_code");
    assert.equal(tokens[0]?.form.get("code_verifier"), "verifier-1");
    assert.equal(tokens[0]?.form.get("redirect_uri"), REDIRECT);
    assert.deepEqual(
      tokens[0]?.dpop?.header["jwk"],
      pars[0]?.dpop?.header["jwk"],
      "same DPoP key from PAR onward",
    );
    assert.doesNotMatch(JSON.stringify(tokens[0]?.dpop?.header["jwk"]), /"d"/);

    assert.equal(saved.length, 1);
    const session = saved[0];
    assert.ok(session);
    assert.equal(session.did, DID);
    assert.equal(session.handle, HANDLE);
    assert.equal(session.pdsUrl, PDS);
    assert.equal(session.issuer, ISSUER);
    assert.equal(session.authMethod, "none");
    assert.equal(session.accessToken, "at-1");
    assert.equal(session.refreshToken, "rt-2");
    assert.deepEqual(session.scopes, ["atproto", "transition:generic"]);
    assert.ok(session.expiresAt);
    assert.deepEqual(parseBlueskyOAuthSession(JSON.parse(JSON.stringify(session))), session);
  });

  it("treats an entryway server URL as the issuer and sends no login hint", async () => {
    const mock = world({ entryway: true });
    const provider = blueskyOAuth({ clientId: CLIENT_ID, fetch: mock.fetch, plcDirectoryUrl: PLC });
    const started = await provider.start(startInput(ISSUER));
    const par = mock.requests.find((request) => request.url.pathname === "/oauth/par");
    assert.equal(par?.form.has("login_hint"), false);
    assert.ok(started.authorizationUrl.startsWith(`${ISSUER}/oauth/authorize?`));

    // Without a hint the default server is used.
    const fallback = blueskyOAuth({
      clientId: CLIENT_ID,
      fetch: mock.fetch,
      defaultServer: ISSUER,
    });
    await fallback.start(startInput());
    assert.equal(
      await codeFor(blueskyOAuth({ clientId: CLIENT_ID, fetch: mock.fetch }).start(startInput())),
      "invalid_input",
    );
  });

  it("starts from a DID and rejects a token for a different account", async () => {
    const mock = world({ tokenSub: OTHER_DID });
    const provider = blueskyOAuth({ clientId: CLIENT_ID, fetch: mock.fetch, plcDirectoryUrl: PLC });
    const started = await provider.start(startInput(DID));
    const par = mock.requests.find(
      (request) => request.url.pathname === "/oauth/par" && request.dpop?.payload["nonce"],
    );
    assert.equal(par?.form.get("login_hint"), DID);
    const code = await codeFor(
      provider.complete({
        callbackUrl: `${REDIRECT}?state=state-1&iss=${encodeURIComponent(ISSUER)}&code=code-1`,
        attempt: attemptFor(started.providerState),
      }),
    );
    assert.equal(code, "unauthorized");
  });

  it("rejects a token whose DID is served by a different authorization server", async () => {
    // Server-hint flow: no expected DID, so only the issuer check catches the mix-up.
    const mock = world({ tokenSub: OTHER_DID });
    const provider = blueskyOAuth({ clientId: CLIENT_ID, fetch: mock.fetch, plcDirectoryUrl: PLC });
    const started = await provider.start(startInput(PDS));
    const saved: unknown[] = [];
    const guarded = blueskyOAuth({
      clientId: CLIENT_ID,
      fetch: mock.fetch,
      plcDirectoryUrl: PLC,
      sessionSink: { save: async (input) => void saved.push(input) },
    });
    const code = await codeFor(
      guarded.complete({
        callbackUrl: `${REDIRECT}?state=state-1&iss=${encodeURIComponent(ISSUER)}&code=code-1`,
        attempt: attemptFor(started.providerState),
      }),
    );
    assert.equal(code, "unauthorized");
    assert.equal(saved.length, 0);
  });

  it("requires exactly one matching iss parameter and never echoes the code", async () => {
    const mock = world();
    const provider = blueskyOAuth({
      clientId: CLIENT_ID,
      fetch: mock.fetch,
      plcDirectoryUrl: PLC,
      resolveTxt,
    });
    const started = await provider.start(startInput(HANDLE));
    const attempt = attemptFor(started.providerState);
    for (const query of [
      "state=state-1&code=secret-code",
      "state=state-1&iss=https%3A%2F%2Fevil.test&code=secret-code",
      `state=state-1&iss=${encodeURIComponent(ISSUER)}&iss=${encodeURIComponent(ISSUER)}&code=secret-code`,
    ]) {
      try {
        await provider.complete({ callbackUrl: `${REDIRECT}?${query}`, attempt });
        assert.fail("expected rejection");
      } catch (error) {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, "unauthorized");
        assert.doesNotMatch(JSON.stringify(error.toJSON()), /secret-code/);
        assert.doesNotMatch(error.message, /secret-code/);
      }
    }
    assert.equal(
      mock.requests.some((request) => request.url.pathname === "/oauth/token"),
      false,
    );
    assert.equal(
      await codeFor(
        provider.complete({
          callbackUrl: `${REDIRECT}?state=state-1&error=access_denied`,
          attempt,
        }),
      ),
      "cancelled",
    );
  });

  it("rejects token responses without the atproto scope or a DPoP token type", async () => {
    for (const tokenScope of [null, "transition:generic"]) {
      const mock = world({ tokenScope });
      const provider = blueskyOAuth({
        clientId: CLIENT_ID,
        fetch: mock.fetch,
        plcDirectoryUrl: PLC,
      });
      const started = await provider.start(startInput(DID));
      assert.equal(
        await codeFor(
          provider.complete({
            callbackUrl: `${REDIRECT}?state=state-1&iss=${encodeURIComponent(ISSUER)}&code=code-1`,
            attempt: attemptFor(started.providerState),
          }),
        ),
        "unauthorized",
      );
    }
  });

  it("rejects non-compliant authorization servers and unverifiable handles", async () => {
    const noPar = world({
      asMetadata: asMetadata({ require_pushed_authorization_requests: false }),
    });
    assert.equal(
      await codeFor(
        blueskyOAuth({ clientId: CLIENT_ID, fetch: noPar.fetch, plcDirectoryUrl: PLC }).start(
          startInput(DID),
        ),
      ),
      "upstream_failure",
    );
    const wrongIssuer = world({ asMetadata: asMetadata({ issuer: "https://elsewhere.test" }) });
    assert.equal(
      await codeFor(
        blueskyOAuth({ clientId: CLIENT_ID, fetch: wrongIssuer.fetch, plcDirectoryUrl: PLC }).start(
          startInput(DID),
        ),
      ),
      "unauthorized",
    );

    const mock = world();
    const conflicting = blueskyOAuth({
      clientId: CLIENT_ID,
      fetch: mock.fetch,
      plcDirectoryUrl: PLC,
      resolveTxt: async () => [[`did=${DID}`], [`did=${OTHER_DID}`]],
    });
    assert.equal(await codeFor(conflicting.start(startInput(HANDLE))), "upstream_failure");

    // The DID document for OTHER_DID claims other.pds.test, not alice.pds.test.
    const unconfirmed = blueskyOAuth({
      clientId: CLIENT_ID,
      fetch: mock.fetch,
      plcDirectoryUrl: PLC,
      resolveTxt: async () => [[`did=${OTHER_DID}`]],
    });
    assert.equal(await codeFor(unconfirmed.start(startInput(HANDLE))), "unauthorized");

    const provider = blueskyOAuth({ clientId: CLIENT_ID, fetch: mock.fetch });
    for (const hint of ["alice.local", "did:key:z6Mk", "not a handle", "https://pds.test/path"])
      assert.equal(await codeFor(provider.start(startInput(hint))), "invalid_input");
  });

  it("authenticates confidential clients with an ES256 client assertion", async () => {
    const key = await signingKey();
    const mock = world();
    const provider = blueskyOAuth({
      clientId: CLIENT_ID,
      clientKey: key,
      fetch: mock.fetch,
      plcDirectoryUrl: PLC,
    });
    await provider.start(startInput(DID));
    const pars = mock.requests.filter((request) => request.url.pathname === "/oauth/par");
    const assertions = pars.map((request) => request.form.get("client_assertion"));
    assert.notEqual(assertions[0], assertions[1], "fresh assertion on nonce retry");
    for (const request of pars) {
      assert.equal(
        request.form.get("client_assertion_type"),
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      );
      const jwt = await verifyJwt(
        request.form.get("client_assertion") ?? "",
        blueskyOAuthPublicJwk(key),
      );
      assert.equal(jwt.header["alg"], "ES256");
      assert.equal(jwt.header["kid"], "key-1");
      assert.equal(jwt.payload["iss"], CLIENT_ID);
      assert.equal(jwt.payload["sub"], CLIENT_ID);
      assert.equal(jwt.payload["aud"], ISSUER);
      assert.equal(typeof jwt.payload["jti"], "string");
      assert.equal(Number(jwt.payload["exp"]) - Number(jwt.payload["iat"]), 60);
    }

    const publicJwk = blueskyOAuthPublicJwk(key);
    assert.equal(publicJwk.d, undefined);
    assert.equal(publicJwk.kid, "key-1");
    assert.throws(
      () => blueskyOAuth({ clientId: "http://localhost", clientKey: key }),
      (error: unknown) => error instanceof SocialError && error.code === "invalid_config",
    );
    assert.throws(
      () => blueskyOAuth({ clientId: "http://app.test/client-metadata.json" }),
      SocialError,
    );
    assert.throws(
      () => blueskyOAuth({ clientId: CLIENT_ID, scope: "transition:generic" }),
      SocialError,
    );
  });

  it("runs through ConnectionManager without exposing provider state", async () => {
    const mock = world();
    const store = new MemoryConnectionStore();
    const manager = new ConnectionManager({ store });
    const provider = blueskyOAuth({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      fetch: mock.fetch,
      resolveTxt,
      plcDirectoryUrl: PLC,
    });
    const started = await manager.begin({
      backend: "direct",
      tenantId: "tenant",
      principalId: "user",
      platforms: ["bluesky"],
      redirectUri: REDIRECT,
      allowedRedirectUris: [REDIRECT],
      provider,
      loginHint: HANDLE,
    });
    assert.equal("providerState" in started.attempt, false);
    assert.equal("codeVerifier" in started.attempt, false);

    const stored = await store.get(started.attempt.id);
    assert.ok(stored?.providerState);
    const par = mock.requests.find((request) => request.url.pathname === "/oauth/par");
    assert.equal(par?.form.get("state"), started.attempt.state);
    assert.equal(par?.form.get("code_challenge"), await sha256(stored.codeVerifier));

    const discovered = await manager.discover({
      attemptId: started.attempt.id,
      tenantId: "tenant",
      principalId: "user",
      callbackUrl: `${REDIRECT}?iss=${encodeURIComponent(ISSUER)}&state=${started.attempt.state}&code=code-1`,
      returnedState: started.attempt.state,
      allowedRedirectUris: [REDIRECT],
      provider,
    });
    assert.equal(discovered[0]?.ref.accountId, DID);
    const token = mock.requests.find((request) => request.url.pathname === "/oauth/token");
    assert.equal(token?.form.get("code_verifier"), stored.codeVerifier);
  });

  it("publishes through the Bluesky adapter with DPoP-bound requests and a PDS nonce retry", async () => {
    const mock = world();
    const saved: BlueskyOAuthSession[] = [];
    const provider = blueskyOAuth({
      clientId: CLIENT_ID,
      fetch: mock.fetch,
      plcDirectoryUrl: PLC,
      sessionSink: { save: async ({ session }) => void saved.push(session) },
    });
    const started = await provider.start(startInput(DID));
    await provider.complete({
      callbackUrl: `${REDIRECT}?state=state-1&iss=${encodeURIComponent(ISSUER)}&code=code-1`,
      attempt: attemptFor(started.providerState),
    });
    const session = saved[0];
    assert.ok(session);

    const transport = blueskyOAuthTransport(session, { fetch: mock.fetch });
    const adapter = bluesky({
      backend: "direct",
      auth: { service: transport.service, did: transport.did },
      session: transport,
    });
    const before = mock.requests.length;
    const result = await adapter.posts?.publishTarget(
      {
        targetIndex: 0,
        targetKey: "oauth",
        account: connectedAccountRef({ backend: "direct", platform: "bluesky", accountId: DID }),
        content: { text: "hello from oauth" },
      },
      context(),
    );
    assert.equal(result?.state, "published");

    const xrpc = mock.requests
      .slice(before)
      .filter((request) => request.url.pathname.startsWith("/xrpc/"));
    assert.equal(xrpc.length, 2, "one retry after use_dpop_nonce");
    const expectedAth = await sha256("at-1");
    for (const request of xrpc) {
      assert.equal(request.url.origin, PDS);
      assert.equal(request.headers.get("authorization"), "DPoP at-1");
      assert.equal(request.dpop?.payload["ath"], expectedAth);
      assert.equal(request.dpop?.payload["htm"], "POST");
      assert.equal(request.dpop?.payload["htu"], `${PDS}/xrpc/com.atproto.repo.createRecord`);
      assert.deepEqual(request.dpop?.header["jwk"], {
        kty: "EC",
        crv: "P-256",
        x: session.dpopKey.x,
        y: session.dpopKey.y,
      });
    }
    assert.equal(xrpc[0]?.dpop?.payload["nonce"], undefined);
    assert.equal(xrpc[1]?.dpop?.payload["nonce"], "pds-nonce-1");

    // The learned nonce is reused, and query strings stay out of htu.
    const read = await transport.fetchHandler("/xrpc/app.bsky.actor.getProfile?actor=alice", {
      method: "GET",
    });
    assert.equal(read.status, 200);
    const last = mock.requests.at(-1);
    assert.equal(last?.dpop?.payload["nonce"], "pds-nonce-1");
    assert.equal(last?.dpop?.payload["htu"], `${PDS}/xrpc/app.bsky.actor.getProfile`);

    await assert.rejects(transport.fetchHandler("https://evil.test/xrpc/x"), SocialError);
    await assert.rejects(transport.fetchHandler("//evil.test/xrpc/x"), SocialError);
  });

  it("refreshes with the same DPoP key, rotates the refresh token, and maps reuse to reconnect", async () => {
    const mock = world();
    const saved: BlueskyOAuthSession[] = [];
    const provider = blueskyOAuth({
      clientId: CLIENT_ID,
      fetch: mock.fetch,
      plcDirectoryUrl: PLC,
      sessionSink: { save: async ({ session }) => void saved.push(session) },
    });
    const started = await provider.start(startInput(DID));
    await provider.complete({
      callbackUrl: `${REDIRECT}?state=state-1&iss=${encodeURIComponent(ISSUER)}&code=code-1`,
      attempt: attemptFor(started.providerState),
    });
    const session = saved[0];
    assert.ok(session);

    const options = { clientId: CLIENT_ID, fetch: mock.fetch, plcDirectoryUrl: PLC };
    const next = await refreshBlueskyOAuthSession(session, options);
    assert.equal(next.accessToken, "at-2");
    assert.equal(next.refreshToken, "rt-3");
    assert.deepEqual(next.dpopKey, session.dpopKey);
    const refresh = mock.requests
      .filter((request) => request.form.get("grant_type") === "refresh_token")
      .at(-1);
    assert.equal(refresh?.form.get("refresh_token"), "rt-2");
    assert.equal(
      refresh?.dpop?.header["jwk"] && (refresh.dpop.header["jwk"] as JsonWebKey).x,
      session.dpopKey.x,
    );

    // Replaying the rotated refresh token fails as a reconnect.
    assert.equal(await codeFor(refreshBlueskyOAuthSession(session, options)), "reconnect_required");
    assert.equal(
      await codeFor(
        refreshBlueskyOAuthSession(next, {
          ...options,
          clientId: "https://other.test/client.json",
        }),
      ),
      "invalid_config",
    );
    const { refreshToken: _unused, ...withoutRefresh } = next;
    assert.equal(
      await codeFor(refreshBlueskyOAuthSession(withoutRefresh, options)),
      "reconnect_required",
    );

    // The account moved to a PDS whose issuer differs from the session issuer.
    const moved = world({ pdsIssuer: "https://new-auth.test" });
    assert.equal(
      await codeFor(refreshBlueskyOAuthSession(next, { ...options, fetch: moved.fetch })),
      "unauthorized",
    );
  });

  it("validates stored sessions", () => {
    for (const value of [null, {}, { version: 1, did: DID }, { version: 2 }])
      assert.throws(() => parseBlueskyOAuthSession(value), SocialError);
  });

  it("builds validated client metadata and loopback client IDs", async () => {
    const key = await signingKey();
    const metadata = blueskyOAuthClientMetadata({
      clientId: CLIENT_ID,
      redirectUris: [REDIRECT],
      scope: "atproto transition:generic",
      clientName: "Example",
      clientUri: "https://app.test",
      jwks: { keys: [blueskyOAuthPublicJwk(key)] },
    });
    assert.equal(metadata.dpop_bound_access_tokens, true);
    assert.equal(metadata.token_endpoint_auth_method, "private_key_jwt");
    assert.equal(metadata.token_endpoint_auth_signing_alg, "ES256");
    assert.deepEqual(metadata.grant_types, ["authorization_code", "refresh_token"]);
    assert.deepEqual(metadata.response_types, ["code"]);
    assert.equal(metadata.application_type, "web");

    const publicClient = blueskyOAuthClientMetadata({
      clientId: CLIENT_ID,
      redirectUris: ["test.app:/callback"],
      scope: "atproto",
      applicationType: "native",
    });
    assert.equal(publicClient.token_endpoint_auth_method, "none");
    assert.equal("jwks" in publicClient, false);

    const invalid = [
      { clientId: CLIENT_ID, redirectUris: [REDIRECT], scope: "transition:generic" },
      { clientId: CLIENT_ID, redirectUris: ["http://app.test/cb"], scope: "atproto" },
      { clientId: "https://app.test:8443/client.json", redirectUris: [REDIRECT], scope: "atproto" },
      { clientId: CLIENT_ID, redirectUris: [], scope: "atproto" },
      {
        clientId: CLIENT_ID,
        redirectUris: [REDIRECT],
        scope: "atproto",
        clientUri: "https://other.test",
      },
      {
        clientId: CLIENT_ID,
        redirectUris: [REDIRECT],
        scope: "atproto",
        jwks: { keys: [key.privateJwk] },
      },
      {
        clientId: CLIENT_ID,
        redirectUris: [REDIRECT],
        scope: "atproto",
        jwks: { keys: [blueskyOAuthPublicJwk(key)] },
        jwksUri: "https://app.test/jwks.json",
      },
    ];
    for (const input of invalid)
      assert.throws(() => blueskyOAuthClientMetadata(input), SocialError);

    const loopback = new URL(
      blueskyLoopbackClientId({
        redirectUris: ["http://127.0.0.1:8080/callback"],
        scope: "atproto transition:generic",
      }),
    );
    assert.equal(loopback.origin, "http://localhost");
    assert.equal(loopback.pathname, "/");
    assert.deepEqual(loopback.searchParams.getAll("redirect_uri"), [
      "http://127.0.0.1:8080/callback",
    ]);
    assert.equal(loopback.searchParams.get("scope"), "atproto transition:generic");
    assert.throws(
      () => blueskyLoopbackClientId({ redirectUris: ["http://localhost:8080/cb"] }),
      SocialError,
    );
    assert.doesNotThrow(() => blueskyOAuth({ clientId: loopback.toString() }));
  });
  it("follows up to three HTTPS redirects for the handle method and none for metadata", async () => {
    const mock = world();
    const handleRequests: string[] = [];
    const provider = blueskyOAuth({
      clientId: CLIENT_ID,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === HANDLE || url.hostname === "hop.test") {
          handleRequests.push(`${url.hostname}${url.pathname} ${String(init?.redirect)}`);
          const hop = Number(url.searchParams.get("hop") ?? "0");
          if (hop < 3)
            return new Response(null, {
              status: 302,
              headers: { location: `https://hop.test/did?hop=${hop + 1}` },
            });
          return new Response(`${DID}\n`, { status: 200 });
        }
        return mock.fetch(input, init);
      },
      plcDirectoryUrl: PLC,
      resolveTxt: async () => [],
    });
    await provider.start(startInput(HANDLE));
    assert.deepEqual(handleRequests, [
      `${HANDLE}/.well-known/atproto-did manual`,
      "hop.test/did manual",
      "hop.test/did manual",
      "hop.test/did manual",
    ]);
    for (const request of mock.requests) assert.equal(request.redirect, "manual");

    // A fourth hop is refused.
    const tooMany = blueskyOAuth({
      clientId: CLIENT_ID,
      fetch: async () =>
        new Response(null, { status: 302, headers: { location: "https://hop.test/again" } }),
      resolveTxt: async () => [],
    });
    assert.equal(await codeFor(tooMany.start(startInput(HANDLE))), "upstream_failure");

    // Metadata redirects are failures and are never followed.
    const followed: string[] = [];
    const noMetadataRedirect = blueskyOAuth({
      clientId: CLIENT_ID,
      fetch: async (input) => {
        followed.push(String(input));
        return new Response(null, { status: 302, headers: { location: `${PLC}/moved` } });
      },
      plcDirectoryUrl: PLC,
    });
    assert.equal(await codeFor(noMetadataRedirect.start(startInput(DID))), "upstream_failure");
    assert.deepEqual(followed, [`${PLC}/${DID}`]);
  });

  describe("egress guard", () => {
    const blockedUrls = [
      "http://pds.example.com",
      "https://localhost",
      "https://api.localhost",
      "https://127.0.0.1",
      "https://2130706433",
      "https://0.0.0.0",
      "https://10.1.2.3",
      "https://172.16.0.1",
      "https://192.168.1.1",
      "https://169.254.169.254",
      "https://100.64.0.1",
      "https://224.0.0.1",
      "https://255.255.255.255",
      "https://192.0.2.1",
      "https://[::]",
      "https://[::1]",
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:10.0.0.1]",
      "https://[64:ff9b::a9fe:a9fe]",
      "https://[fe80::1]",
      "https://[fd00::1]",
      "https://[ff02::1]",
      "https://[2001:db8::1]",
      "https://user:pass@pds.example.com",
    ];

    it("allows only HTTPS URLs whose IP-literal hosts are public", () => {
      for (const url of blockedUrls)
        assert.notEqual(egressBlockReason(new URL(url)), undefined, url);
      for (const url of [
        "https://bsky.social",
        "https://8.8.8.8",
        "https://[2606:4700::1111]",
        "https://[::ffff:8.8.8.8]",
      ])
        assert.equal(egressBlockReason(new URL(url)), undefined, url);
    });

    it("rejects handle redirects to blocked targets without fetching them", async () => {
      for (const location of [
        "http://hop.test/did",
        "https://127.0.0.1/did",
        "https://[::1]/did",
        "https://[::ffff:192.168.0.1]/did",
        "https://localhost/did",
      ]) {
        const requested: string[] = [];
        const provider = blueskyOAuth({
          clientId: CLIENT_ID,
          fetch: async (input) => {
            requested.push(String(input));
            return new Response(null, { status: 302, headers: { location } });
          },
          resolveTxt: async () => [],
        });
        assert.equal(await codeFor(provider.start(startInput(HANDLE))), "unauthorized", location);
        assert.equal(requested.length, 1, `${location} is never fetched`);
      }
    });

    it("rejects DID-declared PDS endpoints on blocked hosts without fetching them", async () => {
      for (const pds of [
        "https://10.0.0.5",
        "https://169.254.169.254",
        "https://[fd00::1]",
        "https://100.64.0.1",
        "https://localhost",
      ]) {
        const requested: string[] = [];
        const provider = blueskyOAuth({
          clientId: CLIENT_ID,
          fetch: async (input) => {
            const url = new URL(String(input));
            requested.push(url.origin);
            return json(didDocument(DID, pds));
          },
          plcDirectoryUrl: PLC,
        });
        assert.equal(await codeFor(provider.start(startInput(DID))), "unauthorized", pds);
        assert.deepEqual(requested, [PLC], `${pds} is never fetched`);
      }

      const privatePlc = blueskyOAuth({
        clientId: CLIENT_ID,
        fetch: world().fetch,
        plcDirectoryUrl: "https://192.168.0.10",
      });
      assert.equal(await codeFor(privatePlc.start(startInput(DID))), "unauthorized");
    });

    it("rejects authorization server endpoints on blocked hosts", async () => {
      const internal = "https://127.0.0.1/oauth";
      const parMock = world({
        asMetadata: asMetadata({ pushed_authorization_request_endpoint: internal }),
      });
      const parProvider = blueskyOAuth({
        clientId: CLIENT_ID,
        fetch: parMock.fetch,
        plcDirectoryUrl: PLC,
      });
      assert.equal(await codeFor(parProvider.start(startInput(DID))), "unauthorized");

      const tokenMock = world({ asMetadata: asMetadata({ token_endpoint: internal }) });
      const tokenProvider = blueskyOAuth({
        clientId: CLIENT_ID,
        fetch: tokenMock.fetch,
        plcDirectoryUrl: PLC,
      });
      const started = await tokenProvider.start(startInput(DID));
      const callbackUrl = `${REDIRECT}?state=state-1&iss=${encodeURIComponent(ISSUER)}&code=code-1`;
      assert.equal(
        await codeFor(
          tokenProvider.complete({ callbackUrl, attempt: attemptFor(started.providerState) }),
        ),
        "unauthorized",
      );

      for (const mock of [parMock, tokenMock])
        assert.equal(
          mock.requests.some((request) => request.url.hostname === "127.0.0.1"),
          false,
        );
    });

    it("runs assertEgressAllowed before every request and redirect hop", async () => {
      const mock = world();
      const checked: string[] = [];
      const provider = blueskyOAuth({
        clientId: CLIENT_ID,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.hostname === HANDLE)
            return new Response(null, {
              status: 301,
              headers: { location: "https://hop.test/did" },
            });
          if (url.hostname === "hop.test") return new Response(DID, { status: 200 });
          return mock.fetch(input, init);
        },
        plcDirectoryUrl: PLC,
        resolveTxt: async () => [],
        assertEgressAllowed: (url) => void checked.push(url.hostname),
      });
      await provider.start(startInput(HANDLE));
      assert.deepEqual(checked.slice(0, 3), [HANDLE, "hop.test", "plc.test"]);
      assert.ok(checked.includes("auth.test"));

      const blocked = blueskyOAuth({
        clientId: CLIENT_ID,
        fetch: mock.fetch,
        plcDirectoryUrl: PLC,
        assertEgressAllowed: (url) => {
          if (url.hostname === "pds.test") throw new Error("resolves to a private address");
        },
      });
      assert.equal(await codeFor(blocked.start(startInput(DID))), "unauthorized");
    });

    it("keeps the transport on public HTTPS PDS hosts", async () => {
      const session = parseBlueskyOAuthSession({
        version: 1,
        did: DID,
        pdsUrl: "https://10.0.0.1",
        issuer: ISSUER,
        clientId: CLIENT_ID,
        authMethod: "none",
        accessToken: "at-1",
        scopes: ["atproto"],
        dpopKey: (await signingKey()).privateJwk,
      });
      let called = false;
      const transport = blueskyOAuthTransport(session, {
        fetch: async () => {
          called = true;
          return new Response(null, { status: 200 });
        },
      });
      assert.equal(
        await codeFor(transport.fetchHandler("/xrpc/app.bsky.feed.getTimeline")),
        "unauthorized",
      );
      assert.equal(called, false);
    });
  });

  it("rejects a successful PAR response without a DPoP-Nonce header", async () => {
    const mock = world({ omitNonce: "par" });
    const provider = blueskyOAuth({ clientId: CLIENT_ID, fetch: mock.fetch, plcDirectoryUrl: PLC });
    assert.equal(await codeFor(provider.start(startInput(DID))), "upstream_failure");
  });

  it("publishes only EC P-256 public keys in client metadata jwks", async () => {
    const key = await signingKey();
    const publicJwk = blueskyOAuthPublicJwk(key);
    const base = { clientId: CLIENT_ID, redirectUris: [REDIRECT], scope: "atproto" };
    const metadata = blueskyOAuthClientMetadata({
      ...base,
      jwks: { keys: [{ ...publicJwk, key_ops: ["verify"], ext: true }] },
    });
    assert.deepEqual(metadata.jwks?.keys, [publicJwk]);

    const rejectedKeys: Record<string, unknown>[] = [
      { kty: "oct", k: "c2VjcmV0" },
      { kty: "oct", kid: "hmac" },
      { ...publicJwk, d: key.privateJwk.d },
      { ...publicJwk, k: "c2VjcmV0" },
      ...["p", "q", "dp", "dq", "qi", "oth"].map((member) => ({ ...publicJwk, [member]: "AQAB" })),
      { kty: "RSA", n: "AQAB", e: "AQAB" },
      { kty: "OKP", crv: "Ed25519", x: publicJwk.x },
      { ...publicJwk, crv: "P-384" },
      { kty: "EC", crv: "P-256", x: publicJwk.x },
      { ...publicJwk, x: "short" },
      { ...publicJwk, alg: "RS256" },
      { ...publicJwk, use: "enc" },
    ];
    for (const bad of rejectedKeys) {
      let caught: unknown;
      try {
        blueskyOAuthClientMetadata({ ...base, jwks: { keys: [bad as JsonWebKey] } });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof SocialError, JSON.stringify(Object.keys(bad)));
      assert.equal(caught.code, "invalid_config");
      assert.doesNotMatch(`${caught.message} ${JSON.stringify(caught)}`, /c2VjcmV0/);
      if (key.privateJwk.d !== undefined)
        assert.equal(
          `${caught.message} ${JSON.stringify(caught)}`.includes(key.privateJwk.d),
          false,
        );
    }
  });

  it("returns providerState from begin unless the provider marks it secret", async () => {
    const store = new MemoryConnectionStore();
    const manager = new ConnectionManager({ store });
    const started = await manager.begin({
      backend: "direct",
      tenantId: "tenant",
      principalId: "user",
      platforms: ["linkedin"],
      redirectUri: REDIRECT,
      allowedRedirectUris: [REDIRECT],
      provider: {
        start: async () => ({
          authorizationUrl: "https://provider.test/authorize",
          providerState: "upstream-state",
        }),
        complete: async () => [],
      },
    });
    assert.equal(started.attempt.providerState, "upstream-state");
    assert.equal("codeVerifier" in started.attempt, false);
  });

  describe("revocation after failed identity verification", () => {
    const callbackUrl = `${REDIRECT}?state=state-1&iss=${encodeURIComponent(ISSUER)}&code=code-1`;

    async function rejected(
      options: WorldOptions,
      hint: string,
      clientKey?: BlueskyOAuthSigningKey,
      expected = "unauthorized",
    ) {
      const mock = world(options);
      const saved: BlueskyOAuthSession[] = [];
      const provider = blueskyOAuth({
        clientId: CLIENT_ID,
        fetch: mock.fetch,
        plcDirectoryUrl: PLC,
        ...(clientKey === undefined ? {} : { clientKey }),
        sessionSink: { save: async ({ session }) => void saved.push(session) },
      });
      const started = await provider.start(startInput(hint));
      let caught: unknown;
      try {
        await provider.complete({ callbackUrl, attempt: attemptFor(started.providerState) });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof SocialError, "complete rejects");
      assert.equal(caught.code, expected);
      assert.doesNotMatch(
        `${caught.message} ${String(caught.stack)} ${JSON.stringify(caught)}`,
        /at-1|rt-2|code-1/,
      );
      assert.equal(saved.length, 0);
      const token = mock.requests.find((request) => request.url.pathname === "/oauth/token");
      const revokes = mock.requests.filter((request) => request.url.pathname === "/oauth/revoke");
      return { token, revokes };
    }

    it("revokes the refresh token with the session DPoP key on a subject mismatch", async () => {
      const key = await signingKey();
      const { token, revokes } = await rejected(
        { tokenSub: OTHER_DID, revocation: "ok" },
        DID,
        key,
      );
      assert.equal(revokes.length, 1);
      const revoke = revokes[0];
      assert.equal(revoke?.method, "POST");
      assert.equal(revoke?.form.get("token"), "rt-2");
      assert.equal(revoke?.form.get("token_type_hint"), "refresh_token");
      assert.equal(revoke?.form.get("client_id"), CLIENT_ID);
      const assertion = await verifyJwt(
        revoke?.form.get("client_assertion") ?? "",
        blueskyOAuthPublicJwk(key),
      );
      assert.equal(assertion.payload["aud"], ISSUER);
      assert.deepEqual(revoke?.dpop?.header["jwk"], token?.dpop?.header["jwk"]);
      assert.equal(revoke?.dpop?.payload["nonce"], "as-nonce-1");
      assert.equal(revoke?.dpop?.payload["htu"], `${ISSUER}/oauth/revoke`);
    });

    it("revokes when the account's PDS names a different authorization server", async () => {
      // Server-hint flow: OTHER_DID's PDS points at https://evil-auth.test.
      const { token, revokes } = await rejected({ tokenSub: OTHER_DID, revocation: "ok" }, PDS);
      assert.equal(revokes.length, 1);
      assert.equal(revokes[0]?.form.get("token"), "rt-2");
      assert.equal(revokes[0]?.form.get("client_id"), CLIENT_ID);
      assert.equal(revokes[0]?.form.has("client_assertion"), false);
      assert.deepEqual(revokes[0]?.dpop?.header["jwk"], token?.dpop?.header["jwk"]);
    });

    it("revokes the access token when no refresh token was issued", async () => {
      const { revokes } = await rejected(
        { tokenSub: OTHER_DID, revocation: "ok", noRefreshToken: true },
        DID,
      );
      assert.equal(revokes.length, 1);
      assert.equal(revokes[0]?.form.get("token"), "at-1");
      assert.equal(revokes[0]?.form.get("token_type_hint"), "access_token");
    });

    it("revokes when the token response itself fails validation", async () => {
      for (const [options, expected] of [
        [{ tokenSub: "not-a-did" }, "unauthorized"],
        [{ tokenSub: "did:key:z6Mkabc" }, "unauthorized"],
        [{ tokenType: "Bearer" }, "unauthorized"],
        [{ tokenScope: "transition:generic" }, "unauthorized"],
        [{ omitNonce: "token" }, "upstream_failure"],
      ] as const) {
        const { revokes } = await rejected(
          { ...options, revocation: "ok" },
          DID,
          undefined,
          expected,
        );
        assert.equal(revokes.length, 1, JSON.stringify(options));
        assert.equal(revokes[0]?.form.get("token"), "rt-2");
      }
    });

    it("does not revoke when the server advertises no revocation endpoint", async () => {
      const { revokes } = await rejected({ tokenSub: OTHER_DID }, DID);
      assert.equal(revokes.length, 0);
    });

    it("keeps the original error and sends one request when revocation fails", async () => {
      for (const revocation of ["server-error", "nonce-challenge", "network-error"] as const) {
        const { revokes } = await rejected({ tokenSub: OTHER_DID, revocation }, DID);
        assert.equal(revokes.length, 1, `${revocation}: no retry`);
      }
    });

    it("does not revoke after a successful connection", async () => {
      const mock = world({ revocation: "ok" });
      const provider = blueskyOAuth({
        clientId: CLIENT_ID,
        fetch: mock.fetch,
        plcDirectoryUrl: PLC,
      });
      const started = await provider.start(startInput(DID));
      await provider.complete({ callbackUrl, attempt: attemptFor(started.providerState) });
      assert.equal(
        mock.requests.some((request) => request.url.pathname === "/oauth/revoke"),
        false,
      );
    });

    for (const refreshSub of [OTHER_DID, "not-a-did"])
      it(`revokes a refreshed token whose subject is ${refreshSub}`, async () => {
        const mock = world({ revocation: "ok", refreshSub });
        const saved: BlueskyOAuthSession[] = [];
        const provider = blueskyOAuth({
          clientId: CLIENT_ID,
          fetch: mock.fetch,
          plcDirectoryUrl: PLC,
          sessionSink: { save: async ({ session }) => void saved.push(session) },
        });
        const started = await provider.start(startInput(DID));
        await provider.complete({ callbackUrl, attempt: attemptFor(started.providerState) });
        const session = saved[0];
        assert.ok(session);
        const code = await codeFor(
          refreshBlueskyOAuthSession(session, {
            clientId: CLIENT_ID,
            fetch: mock.fetch,
            plcDirectoryUrl: PLC,
          }),
        );
        assert.equal(code, "unauthorized");
        const refresh = mock.requests.find(
          (request) =>
            request.url.pathname === "/oauth/token" &&
            request.form.get("grant_type") === "refresh_token",
        );
        const revokes = mock.requests.filter((request) => request.url.pathname === "/oauth/revoke");
        assert.equal(revokes.length, 1);
        assert.equal(revokes[0]?.form.get("token"), "rt-3");
        assert.deepEqual(revokes[0]?.dpop?.header["jwk"], refresh?.dpop?.header["jwk"]);
      });
  });
});
