import assert from "node:assert/strict";
import { it } from "node:test";
import {
  ConnectionManager,
  MemoryConnectionStore,
  type ConnectionAccount,
  type ConnectionGrant,
  type ConnectionProvider,
} from "../src/server/connections.js";
import {
  createOAuthConnectHandlers,
  type OAuthConnectHandlersOptions,
  type OAuthConnectPrincipal,
} from "../src/server/oauth-connect.js";
import type { JsonValue } from "../src/core/types.js";
import { parseJson } from "../src/transport/json.js";
import { isJsonObject, isString } from "../src/transport/validation.js";

const accounts: readonly ConnectionAccount[] = [
  {
    ref: {
      kind: "connected-account",
      version: 1,
      backend: "direct",
      platform: "youtube",
      accountId: "channel-1",
    },
    displayName: "One",
  },
  {
    ref: {
      kind: "connected-account",
      version: 1,
      backend: "direct",
      platform: "youtube",
      accountId: "channel-2",
    },
    displayName: "Two",
  },
];

const sessions = new Map<string, OAuthConnectPrincipal>([
  ["alice", { tenantId: "tenant-a", principalId: "alice" }],
  ["bob", { tenantId: "tenant-b", principalId: "bob" }],
]);

interface Harness {
  readonly handlers: ReturnType<typeof createOAuthConnectHandlers>;
  readonly store: MemoryConnectionStore;
  readonly completions: { count: number };
  readonly activations: { attemptId: string; grants: readonly ConnectionGrant[] }[];
  readonly revoked: string[];
  readonly removed: string[];
}

function harness(overrides: Partial<OAuthConnectHandlersOptions> = {}): Harness {
  const store = new MemoryConnectionStore();
  let counter = 0;

  const manager = new ConnectionManager({
    store,
    randomBytes: (length) => new Uint8Array(length).fill(++counter),
    now: () => new Date("2026-10-24T12:00:00.000Z"),
  });

  const completions = { count: 0 };

  const provider: ConnectionProvider = {
    start: async (input) => ({
      authorizationUrl: `https://provider.test/authorize?state=${input.state}`,
      providerState: "secret-provider-state",
      providerStateSecret: true,
    }),
    complete: async () => {
      completions.count++;

      return accounts;
    },
  };

  const activations: Harness["activations"] = [];
  const revoked: string[] = [];
  const removed: string[] = [];

  const grants: readonly ConnectionGrant[] = [
    {
      grantId: "grant-a",
      tenantId: "tenant-a",
      principalId: "alice",
      account: accounts[0]!.ref,
      capabilities: [],
    },
    {
      grantId: "grant-b",
      tenantId: "tenant-b",
      principalId: "bob",
      account: accounts[1]!.ref,
      capabilities: [],
    },
  ];

  const handlers = createOAuthConnectHandlers({
    manager,
    now: () => new Date("2026-10-24T12:00:00.000Z"),
    authenticate: async (request) => {
      const match = /(?:^|;\s*)session=([a-z]+)/.exec(request.headers.get("Cookie") ?? "");

      return match?.[1] === undefined ? undefined : sessions.get(match[1]);
    },
    authorizeMutation: async ({ request }) => request.headers.get("X-CSRF") === "ok",
    connections: {
      youtube: {
        backend: "direct",
        platforms: ["youtube"],
        redirectUri: "https://app.test/oauth/youtube/callback",
        provider,
      },
    },
    credentials: {
      activate: async (input) => {
        activations.push({ attemptId: input.attemptId, grants: input.grants });
      },
    },
    grants: {
      find: async ({ principal, grantId }) =>
        grants.find(
          (grant) =>
            grant.grantId === grantId &&
            grant.tenantId === principal.tenantId &&
            grant.principalId === principal.principalId,
        ),
      revoke: async ({ grant }) => {
        revoked.push(grant.grantId);

        return grant.grantId === "grant-a" ? "already_revoked" : "revoked";
      },
      remove: async ({ grant }) => {
        removed.push(grant.grantId);
      },
    },
    ...overrides,
  });

  return { handlers, store, completions, activations, revoked, removed };
}

function post(
  path: string,
  body: JsonValue,
  options: { session?: string; csrf?: boolean; cookie?: string; contentType?: string } = {},
): Request {
  const cookies = [
    options.session === undefined ? undefined : `session=${options.session}`,
    options.cookie,
  ].filter((value) => value !== undefined);

  const headers = new Headers({ "Content-Type": options.contentType ?? "application/json" });

  if (cookies.length) headers.set("Cookie", cookies.join("; "));

  if (options.csrf !== false) headers.set("X-CSRF", "ok");

  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers,
    body: isString(body) ? body : JSON.stringify(body),
  });
}

function attemptCookie(response: Response): string {
  const header = response.headers.get("Set-Cookie") ?? "";
  const match = /^([^=;]+=[^;]*)/.exec(header);

  assert.ok(match?.[1], "begin sets the attempt cookie");

  return match[1];
}

async function json(response: Response): Promise<JsonValue> {
  return parseJson(await response.text());
}

async function begin(h: Harness, session = "alice") {
  const response = await h.handlers.begin(
    post("/oauth/begin", { connection: "youtube" }, { session }),
  );

  assert.equal(response.status, 200);
  const body = await json(response);
  assert.ok(isJsonObject(body));
  const authorizationUrl = body["authorizationUrl"];
  assert.ok(isString(authorizationUrl));
  const state = new URL(authorizationUrl).searchParams.get("state") ?? "";

  return { response, body, cookie: attemptCookie(response), state };
}

function callback(query: string, cookie: string, session = "alice"): Request {
  return new Request(`https://app.test/oauth/youtube/callback?${query}`, {
    headers: { Cookie: `session=${session}; ${cookie}` },
  });
}

it("begin returns only the authorization URL and sets a secure attempt cookie", async () => {
  const h = harness();
  const { response, body } = await begin(h);
  const text = JSON.stringify(body);

  assert.deepEqual(Object.keys(body).sort(), ["authorizationUrl", "expiresAt"]);
  assert.ok(!text.includes("secret-provider-state"));
  assert.ok(!text.includes("codeVerifier"));
  assert.ok(!text.includes("tenant-a"));
  const cookie = response.headers.get("Set-Cookie") ?? "";
  assert.match(cookie, /^__Host-social-sdk-connect=v1\.[A-Za-z0-9_-]+;/);
  assert.match(cookie, /; Path=\/(;|$)/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.match(cookie, /; Max-Age=600/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

it("begin rejects missing sessions, missing CSRF, GET, unknown fields, and identity fields", async () => {
  const h = harness();

  assert.equal(
    (await h.handlers.begin(post("/oauth/begin", { connection: "youtube" }))).status,
    401,
  );
  assert.equal(
    (
      await h.handlers.begin(
        post("/oauth/begin", { connection: "youtube" }, { session: "alice", csrf: false }),
      )
    ).status,
    403,
  );
  const get = await h.handlers.begin(new Request("https://app.test/oauth/begin"));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("Allow"), "POST");
  assert.equal(
    (
      await h.handlers.begin(
        post("/oauth/begin", { connection: "youtube", tenantId: "tenant-b" }, { session: "alice" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await h.handlers.begin(post("/oauth/begin", { connection: "nope" }, { session: "alice" })))
      .status,
    400,
  );
  assert.equal(
    (
      await h.handlers.begin(
        post("/oauth/begin", "connection=youtube", {
          session: "alice",
          contentType: "application/x-www-form-urlencoded",
        }),
      )
    ).status,
    415,
  );
  assert.equal(
    (
      await h.handlers.begin(
        post(
          "/oauth/begin",
          { connection: "youtube", loginHint: "x".repeat(20_000) },
          {
            session: "alice",
          },
        ),
      )
    ).status,
    413,
  );
});

it("callback discovers accounts once and returns only safe account fields", async () => {
  const h = harness();
  const { cookie, state } = await begin(h);
  const response = await h.handlers.callback(callback(`code=abc&state=${state}`, cookie));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  const body = await json(response);
  assert.deepEqual(body, {
    status: "discovered",
    accounts: [
      { accountId: "channel-1", platform: "youtube", displayName: "One" },
      { accountId: "channel-2", platform: "youtube", displayName: "Two" },
    ],
  });

  // Reloading the callback reuses persisted discovery without a second exchange.
  const again = await h.handlers.callback(callback(`code=abc&state=${state}`, cookie));
  assert.equal(again.status, 200);
  assert.equal(h.completions.count, 1);
});

it("callback rejects wrong state, duplicate params, missing cookie, other sessions, and POST", async () => {
  const h = harness();
  const { cookie, state } = await begin(h);

  assert.equal((await h.handlers.callback(callback("code=abc&state=wrong", cookie))).status, 403);
  assert.equal(
    (await h.handlers.callback(callback(`code=abc&state=${state}&state=${state}`, cookie))).status,
    400,
  );
  assert.equal(
    (await h.handlers.callback(callback(`code=abc&code=def&state=${state}`, cookie))).status,
    400,
  );
  assert.equal(
    (
      await h.handlers.callback(
        new Request(`https://app.test/oauth/youtube/callback?code=abc&state=${state}`, {
          headers: { Cookie: "session=alice" },
        }),
      )
    ).status,
    400,
  );
  // Bob cannot complete Alice's attempt even with her cookie and state.
  assert.equal(
    (await h.handlers.callback(callback(`code=abc&state=${state}`, cookie, "bob"))).status,
    403,
  );
  assert.equal(
    (
      await h.handlers.callback(
        new Request(`https://app.test/oauth/other/callback?code=abc&state=${state}`, {
          headers: { Cookie: `session=alice; ${cookie}` },
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await h.handlers.callback(
        new Request(`https://app.test/oauth/youtube/callback?code=abc&state=${state}`, {
          method: "POST",
          headers: { Cookie: `session=alice; ${cookie}` },
        }),
      )
    ).status,
    405,
  );
  assert.equal(h.completions.count, 0);
});

it("callback reports provider denial without echoing provider text", async () => {
  const h = harness();
  const { cookie, state } = await begin(h);

  const response = await h.handlers.callback(
    callback(`error=access_denied&error_description=secret%20detail&state=${state}`, cookie),
  );

  assert.equal(response.status, 400);
  const text = await response.text();
  assert.ok(!text.includes("secret detail"));
  assert.match(text, /authorization_denied/);
});

it("callback hides raw provider errors", async () => {
  const h = harness({
    connections: {
      youtube: {
        backend: "direct",
        platforms: ["youtube"],
        redirectUri: "https://app.test/oauth/youtube/callback",
        provider: {
          start: async (input) => ({
            authorizationUrl: `https://provider.test/authorize?state=${input.state}`,
          }),
          complete: async () => {
            throw new Error("token=ya29.leaked refresh_token=secret");
          },
        },
      },
    },
  });

  const { cookie, state } = await begin(h);
  const response = await h.handlers.callback(callback(`code=abc&state=${state}`, cookie));
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.ok(!text.includes("leaked"));
  assert.ok(!text.includes("secret"));
});

it("select commits grants, activates staged credentials, clears the cookie, and refuses replay", async () => {
  const h = harness();
  const { cookie, state } = await begin(h);
  await h.handlers.callback(callback(`code=abc&state=${state}`, cookie));

  const response = await h.handlers.select(
    post("/oauth/select", { accountIds: ["channel-2"] }, { session: "alice", cookie }),
  );

  assert.equal(response.status, 200);
  const body = await json(response);
  assert.deepEqual(body, {
    status: "connected",
    grants: [{ grantId: "grant-1", platform: "youtube", accountId: "channel-2" }],
  });
  assert.match(response.headers.get("Set-Cookie") ?? "", /Max-Age=0/);
  assert.equal(h.activations.length, 1);
  assert.equal(h.activations[0]?.grants[0]?.account.accountId, "channel-2");
  assert.equal(h.store.grants()[0]?.tenantId, "tenant-a");

  const replay = await h.handlers.select(
    post("/oauth/select", { accountIds: ["channel-2"] }, { session: "alice", cookie }),
  );

  assert.equal(replay.status, 403);
  assert.equal(h.store.grants().length, 1);
  assert.equal(h.activations.length, 1);
});

it("select refuses other principals, undiscovered accounts, CSRF failures, and identity fields", async () => {
  const h = harness();
  const { cookie, state } = await begin(h);

  // Selecting before discovery is refused.
  assert.equal(
    (
      await h.handlers.select(
        post("/oauth/select", { accountIds: ["channel-1"] }, { session: "alice", cookie }),
      )
    ).status,
    400,
  );
  await h.handlers.callback(callback(`code=abc&state=${state}`, cookie));

  for (const request of [
    post("/oauth/select", { accountIds: ["channel-1"] }, { session: "bob", cookie }),
    post("/oauth/select", { accountIds: ["other"] }, { session: "alice", cookie }),
    post("/oauth/select", { accountIds: ["channel-1"] }, { session: "alice", cookie, csrf: false }),
  ])
    assert.equal((await h.handlers.select(request)).status, 403);

  assert.equal(
    (
      await h.handlers.select(
        post(
          "/oauth/select",
          { accountIds: ["channel-1"], principalId: "bob" },
          { session: "alice", cookie },
        ),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await h.handlers.select(
        post(
          "/oauth/select",
          { accountIds: ["channel-1", "channel-1"] },
          {
            session: "alice",
            cookie,
          },
        ),
      )
    ).status,
    400,
  );
  assert.equal(h.store.grants().length, 0);
  assert.equal(h.activations.length, 0);
});

it("select reports grants that were committed but whose credentials failed to activate", async () => {
  const h = harness({
    credentials: {
      activate: async () => {
        throw new Error("vault refresh_token=secret");
      },
    },
  });

  const { cookie, state } = await begin(h);
  await h.handlers.callback(callback(`code=abc&state=${state}`, cookie));

  const response = await h.handlers.select(
    post("/oauth/select", { accountIds: ["channel-1"] }, { session: "alice", cookie }),
  );

  assert.equal(response.status, 500);
  const text = await response.text();
  assert.match(text, /activation_failed/);
  assert.ok(!text.includes("secret"));
  assert.equal(h.store.grants().length, 1);
});

it("disconnect revokes then removes only grants the server says this principal owns", async () => {
  const h = harness();

  const own = await h.handlers.disconnect(
    post("/oauth/disconnect", { grantId: "grant-a" }, { session: "alice" }),
  );

  assert.equal(own.status, 200);
  assert.deepEqual(await json(own), {
    status: "disconnected",
    grantId: "grant-a",
    revocation: "already_revoked",
  });
  assert.deepEqual(h.revoked, ["grant-a"]);
  assert.deepEqual(h.removed, ["grant-a"]);

  const other = await h.handlers.disconnect(
    post("/oauth/disconnect", { grantId: "grant-b" }, { session: "alice" }),
  );

  assert.equal(other.status, 404);

  const keyed = await h.handlers.disconnect(
    post("/oauth/disconnect", { grantId: "grant-b", credentialKey: "k" }, { session: "bob" }),
  );

  assert.equal(keyed.status, 400);

  const noCsrf = await h.handlers.disconnect(
    post("/oauth/disconnect", { grantId: "grant-b" }, { session: "bob", csrf: false }),
  );

  assert.equal(noCsrf.status, 403);
  assert.deepEqual(h.removed, ["grant-a"]);
});

it("disconnect keeps the grant when revocation fails", async () => {
  const removed: string[] = [];

  const h = harness({
    grants: {
      find: async ({ principal }) => ({
        grantId: "grant-a",
        tenantId: principal.tenantId,
        principalId: principal.principalId,
        account: accounts[0]!.ref,
        capabilities: [],
      }),
      revoke: async () => {
        throw new Error("provider said access_token=abc");
      },
      remove: async ({ grant }) => {
        removed.push(grant.grantId);
      },
    },
  });

  const response = await h.handlers.disconnect(
    post("/oauth/disconnect", { grantId: "grant-a" }, { session: "alice" }),
  );

  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes("access_token"));
  assert.deepEqual(removed, []);
});

it("disconnect refuses a lookup result owned by another tenant", async () => {
  const removed: string[] = [];

  const h = harness({
    grants: {
      find: async () => ({
        grantId: "grant-b",
        tenantId: "tenant-b",
        principalId: "bob",
        account: accounts[1]!.ref,
        capabilities: [],
      }),
      revoke: async () => "revoked",
      remove: async ({ grant }) => {
        removed.push(grant.grantId);
      },
    },
  });

  const response = await h.handlers.disconnect(
    post("/oauth/disconnect", { grantId: "grant-b" }, { session: "alice" }),
  );

  assert.equal(response.status, 404);
  assert.deepEqual(removed, []);
});

it("refuses configurations with insecure or shared callback URLs", () => {
  const base = harness();
  assert.ok(base.handlers);

  const provider: ConnectionProvider = {
    start: async () => ({ authorizationUrl: "https://provider.test/a" }),
    complete: async () => accounts,
  };

  const options = (redirectUris: readonly string[]): OAuthConnectHandlersOptions => ({
    manager: new ConnectionManager({ store: new MemoryConnectionStore() }),
    authenticate: async () => undefined,
    authorizeMutation: async () => false,
    connections: Object.fromEntries(
      redirectUris.map((redirectUri, index) => [
        `c${index}`,
        { backend: "direct", platforms: ["youtube"], redirectUri, provider },
      ]),
    ),
    credentials: { activate: async () => undefined },
    grants: {
      find: async () => undefined,
      revoke: async () => "revoked",
      remove: async () => undefined,
    },
  });

  assert.throws(() => createOAuthConnectHandlers(options(["http://app.test/cb"])));
  assert.throws(() => createOAuthConnectHandlers(options(["https://app.test/cb#x"])));
  assert.throws(() =>
    createOAuthConnectHandlers(options(["https://app.test/cb", "https://app.test/cb?x=1"])),
  );
  assert.throws(() => createOAuthConnectHandlers(options([])));
});
