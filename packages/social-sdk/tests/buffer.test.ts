import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import {
  buffer,
  bufferAuthorizationUrl,
  createBufferPkce,
  exchangeBufferCode,
  refreshBufferToken,
} from "../src/cloud/buffer.js";
import { SocialError } from "../src/core/errors.js";
import { isJsonValue } from "../src/transport/json.js";
import { object, string } from "../src/transport/validation.js";
import type { AdapterOperationContext, JsonObject, JsonValue } from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-10-09T12:00:00.000Z");

const future = "2026-10-10T15:00:00.000Z";

const x = connectedAccountRef({
  backend: "default",
  platform: "x",
  accountId: "channel_x_example",
});

const youtube = connectedAccountRef({
  backend: "default",
  platform: "youtube",
  accountId: "channel_yt_example",
});

const instagram = connectedAccountRef({
  backend: "default",
  platform: "instagram",
  accountId: "channel_ig_example",
});

const tiktok = connectedAccountRef({
  backend: "default",
  platform: "tiktok",
  accountId: "channel_tt_example",
});

function graphql(init?: RequestInit) {
  const parsed: unknown = JSON.parse(String(init?.body));

  if (!isJsonValue(parsed)) throw new Error("GraphQL fixture body must be JSON.");

  const body = object(parsed);

  return { query: string(body["query"]), variables: object(body["variables"] ?? {}) };
}

function envelope(data: JsonValue, errors?: readonly JsonObject[]): Response {
  return Response.json(errors ? { data, errors } : { data });
}

const organizations = {
  account: {
    organizations: [{ id: "org_example" }, { id: "org_other_example" }],
  },
};

const channel = (fields: JsonObject): JsonObject => ({
  id: "channel_x_example",
  name: "demo",
  displayName: "Demo",
  service: "twitter",
  organizationId: "org_example",
  ...fields,
});

const post = (fields: JsonObject): JsonObject => ({
  id: "post_example",
  text: "Hello from Buffer",
  channelId: "channel_x_example",
  channelService: "twitter",
  dueAt: future,
  sentAt: null,
  status: "scheduled",
  shareMode: "customScheduled",
  externalLink: null,
  metrics: null,
  ...fields,
});

function channelsFetch(init?: RequestInit): Response {
  const { query, variables } = graphql(init);

  if (query.includes("AccountOrganizations")) return envelope(organizations);

  if (query.includes("query Channels")) {
    const org = string(object(variables["input"])["organizationId"]);

    if (org === "org_example")
      return envelope({
        channels: [
          channel({}),
          channel({
            id: "channel_pin_example",
            name: "pins",
            displayName: "Pins",
            service: "pinterest",
          }),
          channel({
            id: "channel_yt_example",
            name: "studio",
            displayName: "Studio",
            service: "youtube",
          }),
        ],
      });

    if (org === "org_other_example") return envelope({ channels: [] });
  }

  return envelope(null, [{ message: "unexpected query", extensions: { code: "UNEXPECTED" } }]);
}

it("Buffer lists supported channels and skips services outside the selected platforms", async () => {
  const adapter = buffer({
    apiKey: "fixture-key",
    clock,
    fetch: async (input, init) => {
      assert.equal(String(input), "https://api.buffer.com/");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");

      return channelsFetch(init);
    },
  });

  const page = await adapter.accounts.list({ limit: 1 }, context);

  assert.deepEqual(
    page.items.map((item) => [item.ref.platform, item.ref.accountId, item.handle, item.status]),
    [["x", "channel_x_example", "demo", "connected"]],
  );
  assert.equal(page.nextCursor, "1");

  const next = await adapter.accounts.list({ cursor: "1", limit: 1 }, context);

  assert.deepEqual(
    next.items.map((item) => [item.ref.platform, item.ref.accountId]),
    [["youtube", "channel_yt_example"]],
  );
  assert.equal(next.nextCursor, undefined);
  assert.equal((await adapter.accounts.get(x, context)).displayName, "Demo");
});

it("Buffer uses a configured organization and rejects an empty key", async () => {
  const adapter = buffer({
    apiKey: "fixture-key",
    organizationId: "org_example",
    fetch: async (_input, init) => {
      const { query, variables } = graphql(init);

      assert.ok(!query.includes("AccountOrganizations"));
      assert.equal(object(variables["input"])["organizationId"], "org_example");

      return envelope({ channels: [channel({})] });
    },
  });

  assert.equal(
    (await adapter.accounts.list({}, context)).items[0]?.ref.accountId,
    "channel_x_example",
  );

  assert.throws(
    () => buffer({ apiKey: "   ", fetch: async () => envelope({}) }),
    (error) => error instanceof SocialError && error.code === "invalid_config",
  );
  assert.throws(
    () =>
      buffer({
        apiKey: "fixture-key",
        organizationId: "org example",
        fetch: async () => envelope({}),
      }),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Buffer prepares public HTTPS media and rejects uploads, documents, and unmapped options", () => {
  const social = createSocial({
    backend: buffer({ apiKey: "fixture-key", clock, fetch: async () => envelope({}) }),
    clock,
  });

  const codes = (request: Parameters<typeof social.posts.prepare>[0]) =>
    social.posts.prepare(request).issues.map((issue) => issue.code);

  assert.equal(
    social.posts.prepare({ targets: [{ account: x }], content: { text: "hi" } }).ok,
    true,
  );
  assert.ok(
    codes({
      targets: [{ account: x }],
      content: { text: "hi" },
      schedule: { at: "2026-10-09T11:00:00.000Z" },
    }).includes("schedule.past"),
  );
  assert.ok(
    codes({
      targets: [{ account: x }],
      content: {
        text: "hi",
        media: [
          {
            kind: "image",
            mimeType: "image/png",
            filename: "a.png",
            source: { kind: "blob", blob: new Blob([new Uint8Array(1)]), fingerprint: "b1" },
          },
        ],
      },
    }).includes("media.url_required"),
  );
  assert.ok(
    codes({
      targets: [{ account: x }],
      content: {
        text: "hi",
        media: [
          {
            kind: "document",
            mimeType: "application/pdf",
            filename: "a.pdf",
            source: { kind: "https-url", url: "https://cdn.example/a.pdf" },
          },
        ],
      },
    }).includes("media.document_unsupported"),
  );
  assert.deepEqual(
    codes({
      targets: [{ account: x }],
      content: {
        text: "hi",
        media: [
          {
            kind: "image",
            mimeType: "image/png",
            source: { kind: "https-url", url: "https://cdn.example/launch.png" },
          },
        ],
      },
    }),
    [],
  );
  assert.ok(
    codes({
      targets: [{ account: x, options: { replySettings: "everyone" } }],
      content: { text: "hi" },
    }).includes("options.unmapped"),
  );
  assert.ok(
    codes({
      targets: [
        {
          account: connectedAccountRef({
            backend: "default",
            platform: "tiktok",
            accountId: "channel_tt_example",
          }),
          options: { privacy: "PUBLIC_TO_EVERYONE", consentGiven: true, aiGenerated: false },
        },
      ],
      content: {
        media: [
          {
            kind: "video",
            mimeType: "video/mp4",
            source: { kind: "https-url", url: "https://cdn.example/clip.mp4" },
          },
        ],
      },
    }).includes("options.unmapped"),
  );
});

it("Buffer publishes now or on a custom schedule and maps documented metadata", async () => {
  const seen: JsonObject[] = [];

  const adapter = buffer({
    apiKey: "fixture-key",
    organizationId: "org_example",
    clock,
    fetch: async (_input, init) => {
      const { query, variables } = graphql(init);

      if (query.includes("query Channels"))
        return envelope({
          channels: [
            channel({}),
            channel({
              id: "channel_yt_example",
              name: "studio",
              displayName: "Studio",
              service: "youtube",
            }),
          ],
        });

      if (query.includes("createPost")) {
        seen.push(object(variables["input"]));

        const mode = object(variables["input"])["mode"];

        return envelope({
          createPost: {
            post: post({
              status: mode === "shareNow" ? "sending" : "scheduled",
              shareMode: mode === "shareNow" ? "shareNow" : "customScheduled",
              dueAt: mode === "shareNow" ? null : future,
              channelId: string(object(variables["input"])["channelId"]),
              channelService:
                object(variables["input"])["channelId"] === "channel_yt_example"
                  ? "youtube"
                  : "twitter",
            }),
          },
        });
      }

      return envelope(null, [{ message: "unexpected", extensions: { code: "UNEXPECTED" } }]);
    },
  });

  const social = createSocial({ backend: adapter, clock });

  const nowResult = await social.posts.publish(
    { targets: [{ account: x }], content: { text: "Shipping today." } },
    { authorization: { tenantId: "tenant-from-session" } },
  );

  assert.equal(nowResult.outcomes[0]?.state, "processing");
  assert.equal(seen[0]?.["mode"], "shareNow");
  assert.equal(seen[0]?.["schedulingType"], "automatic");
  assert.equal(seen[0]?.["needsApproval"], false);
  assert.deepEqual(seen[0]?.["assets"], []);

  const scheduled = await social.posts.publish(
    {
      targets: [
        {
          account: youtube,
          options: {
            title: "Walkthrough",
            categoryId: "22",
            visibility: "unlisted",
            madeForKids: false,
          },
        },
      ],
      content: {
        text: "A two-minute tour.",
        media: [
          {
            kind: "video",
            mimeType: "video/mp4",
            source: { kind: "https-url", url: "https://cdn.example/tour.mp4" },
          },
        ],
      },
      schedule: { at: future },
    },
    { authorization: { tenantId: "tenant-from-session" } },
  );

  assert.equal(scheduled.outcomes[0]?.state, "scheduled");
  assert.equal(seen[1]?.["mode"], "customScheduled");
  assert.equal(seen[1]?.["dueAt"], future);
  assert.deepEqual(seen[1]?.["metadata"], {
    youtube: { title: "Walkthrough", categoryId: "22", privacy: "unlisted", madeForKids: false },
  });
  assert.deepEqual(seen[1]?.["assets"], [{ video: { url: "https://cdn.example/tour.mp4" } }]);
});

it("Buffer requires channel-specific YouTube and Instagram choices without TikTok direct-post choices", () => {
  const social = createSocial({
    backend: buffer({ apiKey: "fixture-key", clock, fetch: async () => envelope({}) }),
    clock,
  });

  const video = {
    kind: "video" as const,
    mimeType: "video/mp4",
    source: { kind: "https-url" as const, url: "https://cdn.example/video.mp4" },
  };

  const image = {
    kind: "image" as const,
    mimeType: "image/jpeg",
    source: { kind: "https-url" as const, url: "https://cdn.example/image.jpg" },
  };

  const issues = (request: Parameters<typeof social.posts.prepare>[0]) =>
    social.posts.prepare(request).issues.map((issue) => issue.code);

  assert.ok(
    issues({
      targets: [
        { account: youtube, options: { title: "Tour", visibility: "public", madeForKids: false } },
      ],
      content: { text: "Tour", media: [video] },
    }).includes("youtube.category"),
  );
  assert.ok(
    issues({
      targets: [{ account: instagram }],
      content: { text: "Photo", media: [image] },
    }).includes("instagram.share_to_feed"),
  );
  assert.ok(
    issues({
      targets: [{ account: tiktok }],
      content: { text: "Mixed", media: [video, image] },
    }).includes("tiktok.media_mix"),
  );
});

it("Buffer maps GraphQL and HTTP failures without echoing secrets", async () => {
  const failing = buffer({
    apiKey: "secret-key",
    organizationId: "org_example",
    clock,
    fetch: async (_input, init) => {
      const { query } = graphql(init);

      if (query.includes("query Channels")) return envelope({ channels: [channel({})] });

      if (query.includes("createPost"))
        return envelope({ createPost: { message: "Text is required" } });

      return envelope(null, [{ message: "Not authorized", extensions: { code: "UNAUTHORIZED" } }]);
    },
  });

  const social = createSocial({ backend: failing, clock });
  const prepared = social.posts.prepare({ targets: [{ account: x }], content: { text: "hi" } });
  const target = prepared.targets[0];

  assert.ok(target);

  await assert.rejects(
    () => failing.posts.publishTarget(target, context),
    (error) =>
      error instanceof SocialError &&
      error.code === "invalid_input" &&
      error.message === "Text is required" &&
      !error.message.includes("secret-key"),
  );

  const adapter = buffer({
    apiKey: "secret-key",
    fetch: async () =>
      envelope(null, [{ message: "Not authorized", extensions: { code: "UNAUTHORIZED" } }]),
  });

  await assert.rejects(
    () => adapter.accounts.list({}, context),
    (error) => error instanceof SocialError && error.code === "reconnect_required",
  );

  const limited = buffer({
    apiKey: "secret-key",
    fetch: async () =>
      new Response(
        JSON.stringify({
          errors: [{ message: "Too many requests", extensions: { code: "RATE_LIMIT_EXCEEDED" } }],
        }),
        { status: 429, headers: { "Retry-After": "12" } },
      ),
  });

  await assert.rejects(
    () => limited.accounts.list({}, context),
    (error) =>
      error instanceof SocialError &&
      error.code === "rate_limited" &&
      error.retryDisposition.kind === "after-delay" &&
      error.retryDisposition.delayMs === 12_000,
  );
});

it("Buffer verifies channel ownership before publishing", async () => {
  let creates = 0;

  const adapter = buffer({
    apiKey: "fixture-key",
    organizationId: "org_example",
    fetch: async (_input, init) => {
      const { query } = graphql(init);

      if (query.includes("query Channels")) return envelope({ channels: [] });

      if (query.includes("createPost")) creates += 1;

      return envelope({ createPost: { post: post({}) } });
    },
  });

  const social = createSocial({ backend: adapter });
  const prepared = social.posts.prepare({ targets: [{ account: x }], content: { text: "hi" } });
  const target = prepared.targets[0];

  assert.ok(target);
  await assert.rejects(
    () => adapter.posts.publishTarget(target, context),
    (error) => error instanceof SocialError && error.code === "not_found",
  );
  assert.equal(creates, 0);
});

it("Buffer scopes post reads and destructive operations to the configured organization", async () => {
  let postReads = 0;

  const adapter = buffer({
    apiKey: "fixture-key",
    organizationId: "org_example",
    fetch: async (_input, init) => {
      const { query } = graphql(init);

      if (query.includes("query Channels")) return envelope({ channels: [] });

      if (query.includes("query Post")) postReads += 1;

      return envelope({ post: post({}) });
    },
  });

  const ref = {
    kind: "platform-post" as const,
    version: 1 as const,
    backend: "default",
    platform: "x" as const,
    accountId: "channel_x_example",
    postId: "post_example",
  };

  await assert.rejects(
    () => adapter.posts.get!(ref, context),
    (error) => error instanceof SocialError && error.code === "not_found",
  );
  assert.equal(postReads, 0);
});

it("Buffer reports preflight timeouts as before-submission outcomes", async () => {
  const adapter = buffer({
    apiKey: "fixture-key",
    timeoutMs: 1,
    fetch: async () => new Promise<Response>(() => {}),
  });

  const social = createSocial({ backend: adapter });

  const result = await social.posts.publish({
    targets: [{ account: x }],
    content: { text: "hello" },
  });

  assert.deepEqual(result.outcomes[0], {
    state: "not-submitted",
    targetIndex: 0,
    account: x,
    observedAt: result.outcomes[0]?.observedAt,
    reason: "before-submission",
  });
});

it("Buffer reads, lists, cancels, and deletes posts from mocked GraphQL fixtures", async () => {
  const adapter = buffer({
    apiKey: "fixture-key",
    organizationId: "org_example",
    clock,
    fetch: async (_input, init) => {
      const { query, variables } = graphql(init);

      if (query.includes("query Channels")) return envelope({ channels: [channel({})] });

      if (query.includes("query Posts("))
        return envelope({
          posts: {
            edges: [{ cursor: "cursor_example", node: post({}) }],
            pageInfo: { hasNextPage: false, endCursor: "cursor_example" },
          },
        });

      if (query.includes("query Post("))
        return envelope({
          post: post({
            id: string(object(variables["input"])["id"]),
            status:
              string(object(variables["input"])["id"]) === "post_failed_example"
                ? "error"
                : "scheduled",
          }),
        });

      if (query.includes("deletePost"))
        return envelope({ deletePost: { id: string(object(variables["input"])["id"]) } });

      return envelope(null, [{ message: "unexpected", extensions: { code: "UNEXPECTED" } }]);
    },
  });

  const listed = await adapter.posts.list!(x, { limit: 10 }, context);

  assert.deepEqual(listed.items, [
    {
      id: "post_example",
      text: "Hello from Buffer",
      channelId: "channel_x_example",
      status: "scheduled",
      dueAt: future,
      shareMode: "customScheduled",
    },
  ]);

  const read = await adapter.posts.get!(
    {
      kind: "platform-post",
      version: 1,
      backend: "default",
      platform: "x",
      accountId: "channel_x_example",
      postId: "post_example",
    },
    context,
  );

  assert.equal(read["id"], "post_example");

  const delivery = await adapter.posts.getDelivery!(
    {
      kind: "delivery",
      version: 1,
      backend: "default",
      platform: "x",
      accountId: "channel_x_example",
      deliveryId: "post_example",
    },
    context,
  );

  assert.equal(delivery.state, "scheduled");

  const cancelled = await adapter.posts.cancelScheduled!(
    {
      kind: "scheduled-job",
      version: 1,
      backend: "default",
      platform: "x",
      accountId: "channel_x_example",
      jobId: "post_example",
    },
    context,
  );

  assert.deepEqual(cancelled, { state: "cancelled", backendRecord: "deleted" });

  await adapter.posts.deleteBackendRecord!(
    {
      kind: "backend-post",
      version: 1,
      backend: "default",
      platform: "x",
      accountId: "channel_x_example",
      recordId: "post_failed_example",
    },
    context,
  );

  await assert.rejects(
    () =>
      adapter.posts.deleteBackendRecord!(
        {
          kind: "backend-post",
          version: 1,
          backend: "default",
          platform: "x",
          accountId: "channel_x_example",
          recordId: "post_example",
        },
        context,
      ),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Buffer reports post metrics only after a sent post", async () => {
  const adapter = buffer({
    apiKey: "fixture-key",
    organizationId: "org_example",
    clock,
    fetch: async (_input, init) => {
      const { query } = graphql(init);

      if (query.includes("query Channels")) return envelope({ channels: [channel({})] });

      return envelope({
        post: post({
          status: "sent",
          sentAt: "2026-10-09T16:00:00.000Z",
          externalLink: "https://x.com/example/status/1",
          metrics: [
            { type: "reactions", value: 4, unit: "count", name: "Reactions" },
            { type: "mystery", value: 1, unit: "widgets", name: "Mystery" },
          ],
          metricsUpdatedAt: "2026-10-10T00:00:00.000Z",
        }),
      });
    },
  });

  const metrics = await adapter.analytics!.getPostMetrics(
    {
      kind: "platform-post",
      version: 1,
      backend: "default",
      platform: "x",
      accountId: "channel_x_example",
      postId: "post_example",
    },
    context,
  );

  assert.deepEqual(metrics, [
    {
      name: "reactions",
      value: 4,
      unit: "count",
      period: "lifetime",
      freshness: "unknown",
      source: "buffer:x:post",
      fetchedAt: "2026-10-10T00:00:00.000Z",
    },
  ]);
});

it("Buffer keeps metrics out of basic post reads and maps analytics permission errors", async () => {
  const adapter = buffer({
    apiKey: "fixture-key",
    organizationId: "org_example",
    fetch: async (_input, init) => {
      const { query } = graphql(init);

      if (query.includes("query Channels")) return envelope({ channels: [channel({})] });

      if (query.includes("metrics"))
        return envelope(null, [
          { message: "Metrics require an API key", extensions: { code: "FORBIDDEN" } },
        ]);

      assert.doesNotMatch(query, /metricsUpdatedAt/);

      return envelope({ post: post({ status: "sent" }) });
    },
  });

  const ref = {
    kind: "platform-post" as const,
    version: 1 as const,
    backend: "default",
    platform: "x" as const,
    accountId: "channel_x_example",
    postId: "post_example",
  };

  await adapter.posts.get!(ref, context);

  await assert.rejects(
    () => adapter.analytics!.getPostMetrics(ref, context),
    (error) => error instanceof SocialError && error.code === "missing_permission",
  );
});

it("Buffer OAuth helpers require PKCE and never echo grants", async () => {
  const pkce = createBufferPkce();

  assert.match(pkce.codeVerifier, /^[A-Za-z0-9_-]+$/);
  assert.match(pkce.codeChallenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(pkce.codeVerifier, pkce.codeChallenge);

  assert.equal(
    bufferAuthorizationUrl({
      clientId: "client_example",
      redirectUri: "https://app.example/buffer/callback",
      state: "state-example",
      codeChallenge: pkce.codeChallenge,
    }),
    `https://auth.buffer.com/auth?client_id=client_example&redirect_uri=https%3A%2F%2Fapp.example%2Fbuffer%2Fcallback&response_type=code&scope=posts%3Aread+posts%3Awrite+account%3Aread+offline_access&state=state-example&code_challenge=${pkce.codeChallenge}&code_challenge_method=S256&prompt=consent`,
  );

  assert.throws(
    () =>
      bufferAuthorizationUrl({
        clientId: "client_example",
        redirectUri: "http://app.example/callback",
        state: "s",
        codeChallenge: "challenge",
      }),
    (error) => error instanceof SocialError && error.code === "invalid_config",
  );

  const token = await exchangeBufferCode({
    clientId: "client_example",
    clientSecret: "client-secret-fixture",
    code: "code-secret",
    redirectUri: "https://app.example/buffer/callback",
    codeVerifier: "verifier-secret",
    fetch: async (input, init) => {
      assert.equal(String(input), "https://auth.buffer.com/token");
      const body = String(init?.body);

      assert.match(body, /grant_type=authorization_code/);
      assert.match(body, /code_verifier=verifier-secret/);
      assert.match(body, /client_secret=client-secret-fixture/);

      return Response.json({
        access_token: "access-token-fixture",
        refresh_token: "refresh-token-fixture",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "posts:read posts:write account:read offline_access",
      });
    },
  });

  assert.equal(token.accessToken, "access-token-fixture");
  assert.equal(token.refreshToken, "refresh-token-fixture");

  await assert.rejects(
    () =>
      refreshBufferToken({
        clientId: "client_example",
        refreshToken: "refresh-secret",
        fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
      }),
    (error) => {
      assert.ok(error instanceof SocialError && error.code === "invalid_input");
      assert.doesNotMatch(JSON.stringify(error), /refresh-secret|access-token-fixture/);
      assert.doesNotMatch(error.message, /refresh-secret|access-token-fixture/);

      return true;
    },
  );
});
