import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import type { JsonValue } from "../src/core/types.js";
import { x } from "../src/platforms/x.js";
import { revokeXOAuthToken } from "../src/server/oauth.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "x-native-controls",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

interface Seen {
  readonly method: string;
  readonly href: string;
  readonly authorization: string | null;
  readonly body: JsonValue | undefined;
}

function fake(routes: Readonly<Record<string, JsonValue>>) {
  const seen: Seen[] = [];

  const adapter = x({
    auth: { userId: "11", accessToken: "user" },
    appBearerToken: "app",
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

it("deletes every filtered-stream rule with delete_all and the app token", async () => {
  const { native, seen } = fake({
    "POST /2/tweets/search/stream/rules": {
      meta: { sent: "2026-11-04T10:00:00Z", summary: { deleted: 3, not_deleted: 0 } },
    },
  });

  const update = await native.deleteAllStreamRules({ account, context });

  assert.deepEqual(update.summary, { deleted: 3, not_deleted: 0 });
  assert.deepEqual(seen, [
    {
      method: "POST",
      href: "https://api.x.com/2/tweets/search/stream/rules?delete_all=true",
      authorization: "Bearer app",
      body: {},
    },
  ]);

  await native.deleteAllStreamRules({ account, dryRun: true, context });

  assert.equal(
    seen[1]?.href,
    "https://api.x.com/2/tweets/search/stream/rules?delete_all=true&dry_run=true",
  );
});

it("bookmarks several posts into a folder with tweet_ids and folder_id [feature:x.engagement.bookmarks_bulk_folder]", async () => {
  const { native, seen } = fake({
    "POST /2/users/11/bookmarks": {
      data: [
        { tweet_id: "1700000000000000000", bookmarked: true },
        { tweet_id: "1700000000000000001", bookmarked: true },
      ],
      errors: [{ tweet_id: "1700000000000000002", title: "Not Found" }],
    },
  });

  const result = await native.bookmarkPosts({
    account,
    postIds: ["1700000000000000000", "1700000000000000001", "1700000000000000002"],
    folderId: "1500000000000000000",
    context,
  });

  assert.deepEqual(result, {
    bookmarked: ["1700000000000000000", "1700000000000000001"],
    errors: [{ tweet_id: "1700000000000000002", title: "Not Found" }],
  });
  assert.deepEqual(seen[0], {
    method: "POST",
    href: "https://api.x.com/2/users/11/bookmarks",
    authorization: "Bearer user",
    body: {
      tweet_ids: ["1700000000000000000", "1700000000000000001", "1700000000000000002"],
      folder_id: "1500000000000000000",
    },
  });

  await assert.rejects(
    native.bookmarkPosts({
      account,
      postIds: Array.from({ length: 26 }, (_, index) => String(index + 1)),
      context,
    }),
    { code: "invalid_input" },
  );
  assert.equal(seen.length, 1);
});

it("sends media metadata controls including sensitive_media_warning to /2/media/metadata", async () => {
  const { native, seen } = fake({
    "POST /2/media/metadata": {
      data: { id: "1146654567674912769", associated_metadata: { allow_download: false } },
    },
  });

  const associated = await native.setMediaMetadata({
    account,
    mediaId: "1146654567674912769",
    metadata: {
      altText: "A chart of weekly signups",
      allowDownload: false,
      contentExpiresAt: "2026-12-01T00:00:00Z",
      domainAllowlist: ["example.com"],
      foundMediaOrigin: { provider: "giphy", id: "abc123" },
      managed: true,
      shared: false,
      uploadSource: "web",
      sensitiveMediaWarning: { adult_content: true },
      geoRestrictions: { countries: ["US"] },
      audiencePolicy: { creator_subscriptions: ["SUBSCRIBER"] },
    },
    context,
  });

  assert.deepEqual(associated, { allow_download: false });
  assert.deepEqual(seen[0]?.body, {
    id: "1146654567674912769",
    metadata: {
      alt_text: { text: "A chart of weekly signups" },
      allow_download_status: { allow_download: false },
      content_expiration: { timestamp_sec: 1_796_083_200 },
      domain_restrictions: { whitelist: ["example.com"] },
      found_media_origin: { provider: "giphy", id: "abc123" },
      management_info: { managed: true },
      shared_info: { shared: false },
      upload_source: { upload_source: "web" },
      sensitive_media_warning: { adult_content: true },
      geo_restrictions: { countries: ["US"] },
      audience_policy: { creator_subscriptions: ["SUBSCRIBER"] },
    },
  });

  await assert.rejects(
    native.setMediaMetadata({ account, mediaId: "1146654567674912769", metadata: {}, context }),
    { code: "invalid_input" },
  );
});

it("raises ambiguous_outcome when X does not echo the media ID", async () => {
  const { native } = fake({ "POST /2/media/metadata": { data: { id: "1" } } });

  await assert.rejects(
    native.setMediaMetadata({
      account,
      mediaId: "1146654567674912769",
      metadata: { allowDownload: true },
      context,
    }),
    { code: "ambiguous_outcome" },
  );
});

it("filters Direct Message reads with event_types", async () => {
  const { native, seen } = fake({
    "GET /2/dm_events": { data: [{ id: "1", event_type: "MessageCreate", text: "hi" }] },
    "GET /2/dm_conversations/123-456/dm_events": { data: [] },
  });

  const page = await native.listDirectMessages({
    account,
    eventTypes: ["MessageCreate"],
    context,
  });

  assert.equal(page.items.length, 1);
  assert.equal(new URL(seen[0]?.href ?? "").searchParams.get("event_types"), "MessageCreate");

  await native.listDirectMessages({
    account,
    conversationId: "123-456",
    eventTypes: ["ParticipantsJoin", "ParticipantsLeave"],
    context,
  });

  assert.equal(
    new URL(seen[1]?.href ?? "").searchParams.get("event_types"),
    "ParticipantsJoin,ParticipantsLeave",
  );

  await assert.rejects(native.listDirectMessages({ account, eventTypes: [], context }), {
    code: "invalid_input",
  });
});

it("revokes an X token at /2/oauth2/revoke with client_id or HTTP Basic", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];

  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });

    return Response.json({ revoked: true });
  };

  assert.equal(await revokeXOAuthToken({ clientId: "client", fetch }, { token: "tok" }), "revoked");
  assert.equal(calls[0]?.url, "https://api.x.com/2/oauth2/revoke");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[0]?.init?.body))), {
    token: "tok",
    client_id: "client",
  });

  await revokeXOAuthToken({ clientId: "client", clientSecret: "secret", fetch }, { token: "tok" });

  const headers = new Headers(calls[1]?.init?.headers);

  assert.equal(headers.get("authorization"), `Basic ${btoa("client:secret")}`);
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[1]?.init?.body))), {
    token: "tok",
  });

  await assert.rejects(
    revokeXOAuthToken(
      { clientId: "client", fetch: async () => Response.json({ revoked: false }) },
      { token: "tok" },
    ),
    { code: "upstream_failure" },
  );
});
