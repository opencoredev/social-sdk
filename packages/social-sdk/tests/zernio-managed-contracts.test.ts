import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, createSocial } from "../src/index.js";
import { zernio } from "../src/cloud/zernio.js";
import { zernioNative } from "../src/cloud/zernio-native.js";
import { SocialError } from "../src/core/errors.js";
import type { AdapterOperationContext } from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "zernio-managed-contracts",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const instagram = connectedAccountRef({
  backend: "default",
  platform: "instagram",
  accountId: "64e8f6b5c9a1d2e3f4a5b6c7",
});

/** The query parameters GET /v1/posts documents; any other one returns 400. */
const listPostsParameters = new Set([
  "page",
  "limit",
  "offset",
  "cursor",
  "fields",
  "source",
  "status",
  "platform",
  "profileId",
  "createdBy",
  "fromDate",
  "toDate",
  "dateFrom",
  "dateTo",
  "includeHidden",
  "search",
  "tags",
  "tag",
  "sortBy",
  "accountId",
  // In Zernio's OpenAPI v1.490.0 for GET /v1/posts, though the human list-posts page omits it.
  "updatedSince",
]);

it("Zernio native post listing sends only documented query parameters", async () => {
  const seen: string[][] = [];

  const native = zernioNative({
    apiKey: "fixture-key",
    fetch: async (input) => {
      const url = new URL(String(input));

      assert.equal(url.pathname, "/api/v1/posts");

      const names = [...url.searchParams.keys()];

      seen.push(names);

      const unknown = names.find((name) => !listPostsParameters.has(name));

      if (unknown !== undefined)
        return Response.json(
          { error: `Unknown query parameter: ${unknown}`, type: "invalid_request_error" },
          { status: 400 },
        );

      return Response.json({ posts: [], pagination: { page: 1, limit: 25, total: 0, pages: 0 } });
    },
  });

  await native.listPosts(
    {
      account: instagram,
      status: "published",
      dateFrom: "2026-11-01",
      dateTo: "2026-11-30",
      sortBy: "created-desc",
      createdBy: "507f1f77bcf86cd799439011",
      profileId: "507f1f77bcf86cd799439012",
      includeHidden: false,
      search: "launch",
      tags: ["launch"],
      cursor: "opaque",
    },
    context,
  );

  await native.listPosts({ account: instagram, source: "external", cursor: "2" }, context);

  assert.equal(seen.length, 2);
});

it("Zernio external native post listing walks page-based history to the last page", async () => {
  const queries: URLSearchParams[] = [];

  const native = zernioNative({
    apiKey: "fixture-key",
    fetch: async (input) => {
      const url = new URL(String(input));

      assert.equal(url.pathname, "/api/v1/posts");
      queries.push(url.searchParams);

      const page = Number(url.searchParams.get("page"));

      return Response.json({
        posts: [{ _id: `external${page}`, content: `Post ${page}`, platforms: [] }],
        pagination: { page, limit: 1, total: 2, pages: 2 },
      });
    },
  });

  const first = await native.listPosts(
    { account: instagram, source: "external", limit: 1 },
    context,
  );

  assert.deepEqual(first.posts, [{ _id: "external1", content: "Post 1", platforms: [] }]);
  assert.equal(first.nextCursor, "2");

  const second = await native.listPosts(
    { account: instagram, source: "external", limit: 1, cursor: first.nextCursor },
    context,
  );

  assert.deepEqual(second.posts, [{ _id: "external2", content: "Post 2", platforms: [] }]);
  assert.equal(second.nextCursor, undefined);
  assert.equal(queries[0]?.get("page"), "1");
  assert.equal(queries[1]?.get("page"), "2");
  assert.equal(queries[1]?.get("source"), "external");
  assert.equal(
    queries.some((query) => query.has("cursor")),
    false,
  );

  await assert.rejects(
    native.listPosts({ account: instagram, source: "external", cursor: "opaque" }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
  assert.equal(queries.length, 2);
});

it("Zernio native post listing keeps the opaque cursor for Zernio-authored posts", async () => {
  const queries: URLSearchParams[] = [];

  const native = zernioNative({
    apiKey: "fixture-key",
    fetch: async (input) => {
      queries.push(new URL(String(input)).searchParams);

      return Response.json({ posts: [], pagination: { nextCursor: "next-opaque" } });
    },
  });

  const page = await native.listPosts({ cursor: "opaque" }, context);

  assert.equal(page.nextCursor, "next-opaque");
  assert.equal(queries[0]?.get("cursor"), "opaque");
  assert.equal(queries[0]?.has("page"), false);
});

for (const platform of ["youtube", "tiktok"])
  it(`Zernio rejects recycling on ${platform}, which Zernio excludes from recycling`, () => {
    const social = createSocial({
      backend: zernio({
        apiKey: "fixture-key",
        fetch: async () => {
          throw new Error("Preparation must not dispatch.");
        },
      }),
    });

    const prepared = social.posts.prepare({
      targets: [
        {
          account: connectedAccountRef({
            backend: "default",
            platform,
            accountId: `${platform}_fixture`,
          }),
          options: {
            title: "Recurring upload",
            visibility: "unlisted",
            madeForKids: false,
            recycling: { gap: 1, gapFreq: "week" },
          },
        },
      ],
      content: {
        text: "Recurring upload",
        media: [
          {
            kind: "video",
            mimeType: "video/mp4",
            source: { kind: "https-url", url: "https://cdn.example.test/video.mp4" },
          },
        ],
      },
    });

    assert.equal(prepared.ok, false, `${platform} is excluded from Zernio recycling.`);
    assert.ok(prepared.issues.some((issue) => issue.code === "recycling.platform"));
  });

it("Zernio OAuth app reads retain the Meta webhook and Slack event setup", async () => {
  const webhook = {
    callbackUrl: "https://zernio.com/api/v1/webhooks/facebook/fixture-app",
    verifyToken: "fixture-only-not-a-real-verification-token",
    object: "page",
    fields: ["feed", "messages"],
  };

  const slackEvents = {
    requestUrl: "https://zernio.com/api/v1/webhooks/slack/fixture-slack",
    botEvents: ["message.channels", "app_mention"],
  };

  const apps = {
    "fixture-app": {
      platform: "facebook",
      webhook: { ...webhook, undocumented: "dropped" },
      slackEvents: null,
    },
    "fixture-slack": { platform: "slack", webhook: null, slackEvents, hasSlackSigningSecret: true },
  };

  const native = zernioNative({
    apiKey: "fixture-key",
    fetch: async (input) => {
      const id = new URL(String(input)).pathname.replace("/api/v1/connect/oauth-apps/", "");

      const extra = id === "fixture-app" ? apps["fixture-app"] : apps["fixture-slack"];

      return Response.json({
        app: {
          id,
          label: "Fixture app",
          clientId: "fixture-client-id",
          scopeAreas: ["posting", "comments", "messaging"],
          status: "ok",
          accountCount: 0,
          redirectUri: "https://zernio.com/api/v1/connect/facebook/callback",
          createdAt: "2026-11-04T12:00:00Z",
          ...extra,
        },
      });
    },
  });

  const meta = await native.getOAuthApp({ appId: "fixture-app" }, context);

  assert.deepEqual(meta["webhook"], webhook);
  assert.equal(meta["slackEvents"], null);

  const slack = await native.getOAuthApp({ appId: "fixture-slack" }, context);

  assert.equal(slack["webhook"], null);
  assert.deepEqual(slack["slackEvents"], slackEvents);
  assert.equal(slack["hasSlackSigningSecret"], true);
});
