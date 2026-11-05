import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import { definedFields } from "../src/core/fields.js";
import type { JsonValue } from "../src/core/types.js";
import { exchangeXOAuth1Token } from "../src/server/oauth.js";
import { decodePlatformWebhook } from "../src/server/webhooks.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "x-streams",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

interface Seen {
  readonly method: string;
  readonly href: string;
  readonly authorization: string | null;
  readonly body: JsonValue | undefined;
}

function fake(
  routes: Readonly<Record<string, JsonValue>>,
  credentials: { readonly appBearerToken?: string } = { appBearerToken: "app" },
) {
  const seen: Seen[] = [];

  const adapter = x({
    auth: { userId: "11", accessToken: "user" },
    ...definedFields({ appBearerToken: credentials.appBearerToken }),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      seen.push({
        method,
        href: url.href,
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });

      const response = routes[`${method} ${url.pathname}`];

      return response === undefined
        ? Response.json({ title: "Not Found" }, { status: 404 })
        : Response.json(response);
    },
  });

  assert.ok(adapter.native);

  return { native: adapter.native, seen };
}

it("decodes filtered-stream rule counts from stream/rules/counts [feature:x.stream.rule_counts]", async () => {
  const { native, seen } = fake({
    "GET /2/tweets/search/stream/rules/counts": {
      data: {
        project_rules_count: 12,
        client_app_rules_count: 7,
        cap_per_project: 1000,
        cap_per_client_app: 1000,
      },
    },
  });

  assert.deepEqual(await native.streamRuleCounts({ account, context }), {
    projectRulesCount: 12,
    clientAppRulesCount: 7,
    capPerProject: 1000,
    capPerClientApp: 1000,
  });
  assert.deepEqual(
    { href: seen[0]?.href, authorization: seen[0]?.authorization },
    {
      href: "https://api.x.com/2/tweets/search/stream/rules/counts",
      authorization: "Bearer app",
    },
  );
  await assert.rejects(fake({}, {}).native.streamRuleCounts({ account, context }), {
    code: "missing_permission",
  });
});

it("links and unlinks a webhook to /2/tweets/search/webhooks [feature:x.stream.webhook_link]", async () => {
  const { native, seen } = fake({
    "GET /2/tweets/search/webhooks": { data: [{ webhook_id: "900", fields: ["created_at"] }] },
    "POST /2/tweets/search/webhooks/900": { data: { provisioned: true } },
    "DELETE /2/tweets/search/webhooks/900": { data: { deleted: true } },
  });

  await native.linkStreamWebhook({ account, webhookId: "900", context });
  assert.deepEqual((await native.streamWebhooks({ account, context })).items, [
    { webhook_id: "900", fields: ["created_at"] },
  ]);
  await native.unlinkStreamWebhook({ account, webhookId: "900", context });

  assert.deepEqual(
    seen.map((entry) => `${entry.method} ${entry.href} ${entry.authorization}`),
    [
      "POST https://api.x.com/2/tweets/search/webhooks/900 Bearer app",
      "GET https://api.x.com/2/tweets/search/webhooks Bearer app",
      "DELETE https://api.x.com/2/tweets/search/webhooks/900 Bearer app",
    ],
  );

  const unconfirmed = fake({
    "POST /2/tweets/search/webhooks/900": { data: { provisioned: false } },
  });

  await assert.rejects(
    unconfirmed.native.linkStreamWebhook({ account, webhookId: "900", context }),
    {
      code: "ambiguous_outcome",
    },
  );
});

it("lists and terminates connections with /2/connections [feature:x.stream.connections]", async () => {
  const killed = {
    data: { successful_kills: 1, failed_kills: 0, results: [{ uuid: "c-1", success: true }] },
  };

  const { native, seen } = fake({
    "GET /2/connections": {
      data: [{ id: "c-1", endpoint_name: "filtered_stream", connected_at: "2026-11-04T09:00:00Z" }],
      meta: { next_token: "n2" },
    },
    "DELETE /2/connections": killed,
    "DELETE /2/connections/filtered_stream": killed,
    "DELETE /2/connections/all": killed,
  });

  const page = await native.streamConnections({
    account,
    status: "all",
    endpoints: ["filtered_stream"],
    limit: 100,
    context,
  });

  assert.deepEqual(page, {
    items: [{ id: "c-1", endpoint_name: "filtered_stream", connected_at: "2026-11-04T09:00:00Z" }],
    nextCursor: "n2",
  });
  assert.equal(
    seen[0]?.href,
    "https://api.x.com/2/connections?connection.fields=id%2Cendpoint_name%2Cclient_ip%2Cconnected_at%2Cdisconnected_at%2Cdisconnect_reason&status=all&endpoints=filtered_stream&max_results=100",
  );

  const expected = { successful: 1, failed: 0, results: [{ uuid: "c-1", success: true }] };

  assert.deepEqual(
    await native.terminateStreamConnections({
      account,
      target: { kind: "uuids", uuids: ["c-1"] },
      context,
    }),
    expected,
  );
  assert.deepEqual(seen[1]?.body, { uuids: ["c-1"] });
  assert.deepEqual(
    await native.terminateStreamConnections({
      account,
      target: { kind: "endpoint", endpoint: "filtered_stream" },
      context,
    }),
    expected,
  );
  assert.deepEqual(
    await native.terminateStreamConnections({ account, target: { kind: "all" }, context }),
    expected,
  );
  assert.deepEqual(
    seen.slice(1).map((entry) => `${entry.method} ${new URL(entry.href).pathname}`),
    ["DELETE /2/connections", "DELETE /2/connections/filtered_stream", "DELETE /2/connections/all"],
  );
});

it("creates, lists, validates, replays and deletes /2/webhooks configs [feature:x.webhooks.manage]", async () => {
  const config = {
    id: "900",
    url: "https://hooks.example.com/x",
    valid: true,
    created_at: "2026-11-04T00:00:00Z",
  };

  const { native, seen } = fake({
    "POST /2/webhooks": { data: config },
    "GET /2/webhooks": { data: [config], meta: { result_count: 1 } },
    "PUT /2/webhooks/900": { data: { valid: true } },
    "POST /2/webhooks/replay": { data: { job_id: "j1", created_at: "2026-11-04T01:00:00Z" } },
    "DELETE /2/webhooks/900": { data: { deleted: true } },
  });

  const expected = {
    id: "900",
    url: "https://hooks.example.com/x",
    valid: true,
    createdAt: "2026-11-04T00:00:00Z",
  };

  assert.deepEqual(
    await native.createWebhook({ account, url: "https://hooks.example.com/x", context }),
    expected,
  );
  assert.deepEqual(seen[0]?.body, { url: "https://hooks.example.com/x" });
  assert.equal(seen[0]?.authorization, "Bearer app");
  assert.deepEqual(await native.listWebhooks({ account, context }), [expected]);
  assert.deepEqual(await native.validateWebhook({ account, webhookId: "900", context }), {
    valid: true,
  });
  assert.deepEqual(
    await native.replayWebhook({
      account,
      webhookId: "900",
      from: "2026-11-03T08:05:00Z",
      to: "2026-11-03T09:30:00Z",
      context,
    }),
    { jobId: "j1", createdAt: "2026-11-04T01:00:00Z" },
  );
  assert.deepEqual(seen[3]?.body, {
    webhook_id: "900",
    from_date: "202611030805",
    to_date: "202611030930",
  });
  await native.deleteWebhook({ account, webhookId: "900", context });
  assert.deepEqual(
    seen.map((entry) => `${entry.method} ${new URL(entry.href).pathname}`),
    [
      "POST /2/webhooks",
      "GET /2/webhooks",
      "PUT /2/webhooks/900",
      "POST /2/webhooks/replay",
      "DELETE /2/webhooks/900",
    ],
  );

  await assert.rejects(native.createWebhook({ account, url: "http://insecure.example", context }), {
    code: "invalid_input",
  });

  const userOnly = fake({ "GET /2/webhooks": { data: [] } }, {});
  await userOnly.native.listWebhooks({ account, context });
  assert.equal(userOnly.seen[0]?.authorization, "Bearer user");
});

it("manages X Activity API subscriptions on /2/activity/subscriptions [feature:x.webhooks.xaa]", async () => {
  const subscription = { subscription: { id: "500", event_type: "post.reply.create" } };

  const { native, seen } = fake({
    "POST /2/activity/subscriptions": { data: subscription },
    "GET /2/activity/subscriptions": { data: [{ id: "500" }] },
    "PUT /2/activity/subscriptions/500": { data: subscription },
    "DELETE /2/activity/subscriptions/500": { data: { deleted: true } },
    "DELETE /2/activity/subscriptions": { data: [{ subscription_id: "500", deleted: true }] },
  });

  assert.deepEqual(
    await native.createActivitySubscription({
      account,
      eventType: "post.reply.create",
      filter: { userId: "11", qualifiers: { post_id: "1700000000000000000" } },
      webhookId: "900",
      tag: "replies",
      context,
    }),
    { data: subscription },
  );
  assert.deepEqual(seen[0]?.body, {
    event_type: "post.reply.create",
    filter: { user_id: "11", qualifiers: { post_id: "1700000000000000000" } },
    webhook_id: "900",
    tag: "replies",
  });
  assert.equal(seen[0]?.authorization, "Bearer user");

  assert.deepEqual(
    (await native.listActivitySubscriptions({ account, userId: "11", context })).items,
    [{ id: "500" }],
  );
  assert.equal(seen[1]?.href, "https://api.x.com/2/activity/subscriptions?user_id=11");

  await native.updateActivitySubscription({
    account,
    subscriptionId: "500",
    tag: "renamed",
    context,
  });
  assert.deepEqual(seen[2]?.body, { tag: "renamed" });

  await native.deleteActivitySubscriptions({ account, subscriptionIds: ["500"], context });
  await native.deleteActivitySubscriptions({ account, subscriptionIds: ["500", "501"], context });
  assert.deepEqual(
    seen.slice(3).map((entry) => `${entry.method} ${entry.href} ${entry.authorization}`),
    [
      "DELETE https://api.x.com/2/activity/subscriptions/500 Bearer user",
      "DELETE https://api.x.com/2/activity/subscriptions?ids=500%2C501 Bearer app",
    ],
  );

  await assert.rejects(
    native.createActivitySubscription({
      account,
      eventType: "like.create",
      filter: { userId: "not-a-user" },
      context,
    }),
    { code: "invalid_input" },
  );
});

it("decodes X Activity API deliveries for post.reply.create, dm.received and oauth.revoke", async () => {
  const body = (value: JsonValue) => new TextEncoder().encode(JSON.stringify(value));

  const reply = await decodePlatformWebhook({
    platform: "x",
    backend: "direct",
    body: body({
      data: {
        event_uuid: "e1",
        event_type: "post.reply.create",
        filter: { user_id: "11" },
        tag: "replies",
        payload: { id: "1700000000000000002", in_reply_to_tweet_id: "1700000000000000000" },
      },
    }),
  });

  assert.equal(reply.type, "comment.received");
  assert.equal(reply.originalType, "post.reply.create");
  assert.deepEqual(reply.accountIds, ["11"]);

  const dm = await decodePlatformWebhook({
    platform: "x",
    backend: "direct",
    body: body({
      data: { event_type: "dm.received", filter: { user_id: "11" }, payload: {} },
    }),
  });

  assert.equal(dm.type, "message.received");

  const revoke = await decodePlatformWebhook({
    platform: "x",
    backend: "direct",
    body: body({
      data: { event_type: "oauth.revoke", filter: {}, payload: { user_id: "11", app_id: "1" } },
    }),
  });

  assert.equal(revoke.type, "account.updated");
  assert.deepEqual(revoke.accountIds, ["11"]);

  const mention = await decodePlatformWebhook({
    platform: "x",
    backend: "direct",
    body: body({
      data: { event_type: "post.mention.create", filter: { user_id: "11" }, payload: {} },
    }),
  });

  assert.equal(mention.type, "unknown");
  assert.equal(mention.originalType, "post.mention.create");
});

it("exchanges OAuth 1.0a tokens with the token-exchange grant [feature:x.auth.oauth1_token_exchange]", async () => {
  const requests: { url: string; headers: Headers; form: URLSearchParams }[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      form: new URLSearchParams(String(init?.body)),
    });

    return Response.json({
      token_type: "bearer",
      expires_in: 7200,
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
      scope: "tweet.read users.read offline.access",
    });
  };

  const tokens = await exchangeXOAuth1Token(
    { clientId: "client", clientSecret: "secret", fetch },
    { token: "oauth1-token", tokenSecret: "oauth1-secret", scopes: ["tweet.read", "users.read"] },
  );

  assert.equal(tokens.accessToken, "fixture-access");
  assert.equal(tokens.refreshToken, "fixture-refresh");
  assert.deepEqual(tokens.scopes, ["tweet.read", "users.read", "offline.access"]);
  assert.equal(requests[0]?.url, "https://api.x.com/2/oauth2/token");
  assert.equal(requests[0]?.headers.get("authorization"), `Basic ${btoa("client:secret")}`);
  assert.deepEqual(Object.fromEntries(requests[0]?.form ?? []), {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: "oauth1-token",
    subject_token_type: "urn:x:params:oauth:token-type:oauth1_token",
    oauth_token_secret: "oauth1-secret",
    scope: "tweet.read users.read",
  });

  await exchangeXOAuth1Token(
    { clientId: "public-client", fetch },
    { token: "t", tokenSecret: "s" },
  );
  assert.equal(requests[1]?.headers.get("authorization"), null);
  assert.equal(requests[1]?.form.get("client_id"), "public-client");

  await assert.rejects(
    exchangeXOAuth1Token({ clientId: "client", fetch }, { token: "", tokenSecret: "s" }),
    { code: "invalid_input" },
  );
  assert.equal(requests.length, 2);
});
