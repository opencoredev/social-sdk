import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { exchangePostizCode, postiz, postizAuthorizationUrl } from "../src/cloud/postiz.js";
import { SocialError } from "../src/core/errors.js";
import { array, object, string } from "../src/transport/validation.js";
import type {
  AdapterOperationContext,
  JsonObject,
  JsonValue,
  PlatformPostRef,
} from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-09-24T12:00:00.000Z");

const future = "2026-09-25T09:00:00.000Z";

const x = connectedAccountRef({ backend: "default", platform: "x", accountId: "int1" });

const tiktok = connectedAccountRef({ backend: "default", platform: "tiktok", accountId: "int5" });

const row = (fields: JsonObject): JsonObject => ({
  id: "p1",
  content: "hello",
  publishDate: future,
  releaseURL: null,
  releaseId: null,
  state: "QUEUE",
  group: "social-sdk-g1",
  integration: { id: "int1", providerIdentifier: "x", name: "Demo" },
  ...fields,
});

const blob = (size: number) => ({
  kind: "blob" as const,
  blob: new Blob([new Uint8Array(size)]),
  fingerprint: `b${size}`,
});

it("Postiz sends the raw API key and maps supported channels", async () => {
  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async (input, init) => {
      const url = new URL(String(input));

      assert.equal(url.href, "https://api.postiz.com/public/v1/integrations");
      assert.equal(new Headers(init?.headers).get("authorization"), "test");

      return Response.json([
        { id: "int1", name: "Demo", identifier: "x", profile: "demo", disabled: false },
        { id: "int9", name: "Pins", identifier: "pinterest", profile: "pins", disabled: false },
        {
          id: "int2",
          name: "Page",
          identifier: "linkedin-page",
          profile: "page",
          disabled: true,
        },
      ]);
    },
  });

  const page = await adapter.accounts.list({ limit: 1 }, context);

  assert.deepEqual(
    page.items.map((item) => [item.ref.platform, item.ref.accountId, item.handle, item.status]),
    [["x", "int1", "demo", "connected"]],
  );
  assert.equal(page.nextCursor, "1");

  const next = await adapter.accounts.list({ cursor: "1", limit: 1 }, context);

  assert.deepEqual(
    next.items.map((item) => [item.ref.platform, item.status]),
    [["linkedin", "unknown"]],
  );
  assert.equal(next.nextCursor, undefined);
  assert.equal((await adapter.accounts.get(x, context)).displayName, "Demo");
});

it("Postiz uses a self-hosted base URL and rejects unsafe ones", async () => {
  const adapter = postiz({
    apiKey: "test",
    baseUrl: "https://postiz.example.test/api/public/v1/",
    fetch: async (input) => {
      assert.equal(String(input), "https://postiz.example.test/api/public/v1/integrations");

      return Response.json([]);
    },
  });

  assert.deepEqual((await adapter.accounts.list({}, context)).items, []);

  for (const baseUrl of [
    "http://postiz.example.test/api/public/v1",
    "https://user:pass@postiz.example.test/api/public/v1",
    "https://postiz.example.test/api/public/v1?x=1",
    "not a url",
  ])
    assert.throws(
      () => postiz({ apiKey: "test", baseUrl, fetch: async () => Response.json({}) }),
      (error) => error instanceof SocialError && error.code === "invalid_config",
    );
});

it("Postiz prepares media, schedule, and platform rules", () => {
  const social = createSocial({
    backend: postiz({ apiKey: "test", clock, fetch: async () => Response.json({}) }),
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
      schedule: { at: "2026-09-24T11:00:00.000Z" },
    }).includes("schedule.past"),
  );

  const media = (item: NonNullable<Parameters<typeof codes>[0]["content"]["media"]>[number]) =>
    codes({ targets: [{ account: x }], content: { text: "hi", media: [item] } });

  assert.ok(
    media({
      kind: "document",
      mimeType: "application/pdf",
      filename: "a.pdf",
      source: blob(1),
    }).includes("media.document_unsupported"),
  );
  assert.ok(
    media({
      kind: "video",
      mimeType: "video/quicktime",
      filename: "a.mov",
      source: blob(1),
    }).includes("media.mime_unsupported"),
  );
  assert.ok(
    media({
      kind: "image",
      mimeType: "image/png",
      filename: "a.png",
      source: blob(10 * 1024 * 1024 + 1),
    }).includes("media.too_large"),
  );
  assert.ok(
    media({
      kind: "image",
      mimeType: "image/png",
      source: { kind: "https-url", url: "https://example.com/image?id=1" },
    }).includes("media.url_extension"),
  );
  assert.deepEqual(
    media({
      kind: "image",
      mimeType: "image/png",
      source: { kind: "https-url", url: "https://example.com/a.png" },
    }),
    [],
  );

  const instagram = connectedAccountRef({
    backend: "default",
    platform: "instagram",
    accountId: "int3",
  });

  assert.ok(
    codes({
      targets: [{ account: instagram, options: { shareToFeed: false } }],
      content: {
        media: [{ kind: "video", mimeType: "video/mp4", filename: "a.mp4", source: blob(1) }],
      },
    }).includes("instagram.share_to_feed_unsupported"),
  );

  const draft = social.posts.prepare({
    targets: [
      {
        account: tiktok,
        options: {
          privacy: "SELF_ONLY",
          consentGiven: true,
          disableComments: false,
          disableDuet: false,
          disableStitch: false,
          brandedContent: false,
          ownBrand: false,
          aiGenerated: false,
          draft: true,
        },
      },
    ],
    content: {
      media: [{ kind: "video", mimeType: "video/mp4", filename: "a.mp4", source: blob(1) }],
    },
  });

  assert.equal(draft.ok, true);
  assert.deepEqual(
    draft.issues.map((issue) => [issue.code, issue.severity]),
    [["tiktok.draft_settings_ignored", "warning"]],
  );
});

it("Postiz uploads bytes, schedules the post, and maps TikTok settings", async () => {
  const calls: string[] = [];

  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async (input, init) => {
      const url = new URL(String(input));

      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);

      if (url.pathname.endsWith("/upload")) {
        assert.ok(init?.body instanceof FormData);
        assert.equal(new Headers(init.headers).get("content-type"), null);
        const file = init.body.get("file");

        assert.ok(file instanceof Blob);
        assert.equal(file.size, 100);
        assert.equal(file.type, "video/mp4");

        return Response.json({ id: "m1", path: "https://uploads.postiz.com/m1.mp4" });
      }

      if (init?.method === "POST") {
        const body = object(JSON.parse(String(init.body)));
        const group = string(object(array(body["posts"])[0])["group"]);

        assert.match(group, /^social-sdk-[0-9a-f-]{36}$/);

        assert.deepEqual(body, {
          type: "schedule",
          date: future,
          shortLink: false,
          tags: [],
          posts: [
            {
              integration: { id: "int5" },
              value: [
                {
                  content: "demo",
                  image: [{ id: "m1", path: "https://uploads.postiz.com/m1.mp4", alt: "Clip" }],
                },
              ],
              group,
              settings: {
                privacy_level: "PUBLIC_TO_EVERYONE",
                duet: false,
                stitch: true,
                comment: true,
                autoAddMusic: "no",
                brand_content_toggle: false,
                brand_organic_toggle: true,
                video_made_with_ai: false,
                content_posting_method: "DIRECT_POST",
              },
            },
          ],
        });

        return Response.json([{ postId: "p1", integration: "int5" }], { status: 201 });
      }

      assert.equal(url.searchParams.get("startDate"), "2026-09-24T09:00:00.000Z");
      assert.equal(url.searchParams.get("endDate"), "2026-09-26T09:00:00.000Z");

      return Response.json({
        posts: [row({ integration: { id: "int5", providerIdentifier: "tiktok" } })],
      });
    },
  });

  const result = await createSocial({ backend: adapter, clock }).posts.publish({
    targets: [
      {
        account: tiktok,
        options: {
          privacy: "PUBLIC_TO_EVERYONE",
          consentGiven: true,
          disableComments: false,
          disableDuet: true,
          disableStitch: false,
          brandedContent: false,
          ownBrand: true,
          aiGenerated: false,
          draft: false,
        },
      },
    ],
    content: {
      text: "demo",
      media: [
        {
          kind: "video",
          mimeType: "video/mp4",
          filename: "demo.mp4",
          altText: "Clip",
          source: blob(100),
        },
      ],
    },
    schedule: { at: future },
  });

  const outcome = result.outcomes[0];

  assert.equal(outcome?.state, "scheduled");
  assert.equal(outcome?.state === "scheduled" ? outcome.job.jobId : undefined, `p1@${future}`);
  assert.deepEqual(calls, [
    "POST /public/v1/upload",
    "POST /public/v1/posts",
    "GET /public/v1/posts",
  ]);
});

it("Postiz cancels an oversized upload stream before any request", async () => {
  let cancelled = false;
  let calls = 0;

  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async () => {
      calls++;

      return Response.json({});
    },
  });

  const stream = new ReadableStream<Uint8Array>({
    pull: (controller) => controller.enqueue(new Uint8Array(6 * 1024 * 1024)),
    cancel: () => {
      cancelled = true;
    },
  });

  await assert.rejects(
    adapter.media.upload(
      {
        kind: "image",
        mimeType: "image/png",
        source: { kind: "stream", open: () => stream, fingerprint: "big" },
      },
      x,
      context,
    ),
    (error) => error instanceof SocialError && error.code === "media_error",
  );
  assert.equal(cancelled, true);
  assert.equal(calls, 0);
});

it("Postiz publishes now and reports an unexpected response as ambiguous", async () => {
  let response: JsonValue = [{ postId: "p1", integration: "other" }];
  let listed = row({ publishDate: "2026-09-24T12:00:00.000Z" });

  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async (_input, init) => {
      if (init?.method === "POST") {
        const body = object(JSON.parse(String(init.body)));

        assert.equal(body["type"], "now");
        assert.equal(body["date"], "2026-09-24T12:00:00.000Z");

        return Response.json(response);
      }

      return Response.json({ posts: [listed] });
    },
  });

  const social = createSocial({ backend: adapter, clock });
  const request = { targets: [{ account: x }], content: { text: "now" } };
  const first = (await social.posts.publish(request)).outcomes[0];

  assert.equal(first?.state, "unknown");
  assert.equal(first?.state === "unknown" ? first.reason : undefined, "ambiguous-submission");

  response = [{ postId: "p1", integration: "int1" }];
  assert.equal((await social.posts.publish(request)).outcomes[0]?.state, "processing");

  // The follow-up read finds the created post on another channel.
  listed = row({ publishDate: "2026-09-24T12:00:00.000Z", integration: { id: "other" } });
  const misplaced = (await social.posts.publish(request)).outcomes[0];

  assert.equal(misplaced?.state, "unknown");
  assert.equal(
    misplaced?.state === "unknown" ? misplaced.reason : undefined,
    "ambiguous-submission",
  );
});

it("Postiz maps delivery states and refuses another account's post", async () => {
  let current = row({});

  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async () => Response.json({ posts: [current] }),
  });

  const ref = { deliveryId: `p1@${future}`, accountId: "int1", platform: "x", backend: "default" };

  assert.equal((await adapter.posts.getDelivery(ref, context)).state, "scheduled");

  current = row({ state: "DRAFT" });
  assert.equal((await adapter.posts.getDelivery(ref, context)).state, "accepted");

  current = row({ publishDate: "not a date" });
  const undated = await adapter.posts.getDelivery(ref, context);

  assert.equal(undated.state, "unknown");
  assert.equal(undated.state === "unknown" ? undated.reason : undefined, "unmapped-state");

  current = row({ state: "PUBLISHED", releaseId: "native1", releaseURL: "https://x.com/i/1" });
  const published = await adapter.posts.getDelivery(ref, context);

  assert.equal(published.state, "published");
  assert.equal(published.state === "published" ? published.url : undefined, "https://x.com/i/1");
  assert.deepEqual(published.state === "published" ? published.post.native : undefined, {
    backendRecordId: `p1@${future}`,
  });

  current = row({ state: "PUBLISHED", releaseId: "missing" });
  assert.equal((await adapter.posts.getDelivery(ref, context)).state, "unknown");

  current = row({ state: "ERROR" });
  assert.equal((await adapter.posts.getDelivery(ref, context)).state, "failed");

  current = row({ integration: { id: "other" } });
  await assert.rejects(
    adapter.posts.getDelivery(ref, context),
    (error) => error instanceof SocialError && error.code === "unauthorized",
  );

  current = row({ id: "p2" });
  await assert.rejects(
    adapter.posts.getDelivery(ref, context),
    (error) => error instanceof SocialError && error.code === "not_found",
  );

  await assert.rejects(
    adapter.posts.getDelivery({ ...ref, deliveryId: "p1" }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Postiz cancels only a future post alone in its group and requires confirmation", async () => {
  let posts = [row({})];
  let deleted: JsonValue = { id: "p1" };
  const methods: string[] = [];

  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async (input, init) => {
      methods.push(init?.method ?? "GET");

      if (init?.method === "DELETE") {
        assert.equal(new URL(String(input)).pathname, "/public/v1/posts/p1");

        return Response.json(deleted);
      }

      return Response.json({ posts });
    },
  });

  const job = {
    kind: "scheduled-job" as const,
    version: 1 as const,
    backend: "default",
    platform: "x" as const,
    accountId: "int1",
    jobId: `p1@${future}`,
  };

  assert.deepEqual(await adapter.posts.cancelScheduled(job, context), {
    state: "cancelled",
    backendRecord: "deleted",
  });

  for (deleted of [null, { id: "p9" }])
    await assert.rejects(
      adapter.posts.cancelScheduled(job, context),
      (error) => error instanceof SocialError && error.code === "ambiguous_outcome",
    );

  methods.length = 0;
  posts = [row({}), row({ id: "p2", integration: { id: "int2" } })];
  await assert.rejects(
    adapter.posts.cancelScheduled(job, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );

  posts = [row({ group: "AbCdEfGh12" })];
  await assert.rejects(
    adapter.posts.cancelScheduled(job, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );

  posts = [row({ integration: { id: "int1", providerIdentifier: "linkedin" } })];
  await assert.rejects(
    adapter.posts.cancelScheduled(job, context),
    (error) => error instanceof SocialError && error.code === "unauthorized",
  );

  posts = [row({ publishDate: "2026-09-24T11:00:00.000Z" })];
  await assert.rejects(
    adapter.posts.cancelScheduled(job, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );

  posts = [row({ state: "PUBLISHED", releaseId: "n1" })];
  await assert.rejects(
    adapter.posts.deleteBackendRecord(
      {
        kind: "backend-post",
        version: 1,
        backend: "default",
        platform: "x",
        accountId: "int1",
        recordId: `p1@${future}`,
      },
      context,
    ),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
  assert.deepEqual(methods, ["GET", "GET", "GET", "GET", "GET"]);
});

it("Postiz reads post analytics and creates OAuth connect links", async () => {
  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async (input) => {
      const url = new URL(String(input));

      if (url.pathname === "/public/v1/analytics/post/p1") {
        assert.equal(url.searchParams.get("date"), "30");

        return Response.json([
          {
            label: "Impressions",
            data: [
              { total: "10", date: "2026-09-23" },
              { total: "42", date: "2026-09-24" },
            ],
          },
          { label: "Link Clicks", data: [{ total: 3, date: "2026-09-24" }] },
          { label: "Broken", data: [{ total: "n/a", date: "2026-09-24" }] },
        ]);
      }

      if (url.pathname === "/public/v1/social/linkedin-page") {
        assert.equal(url.searchParams.get("refresh"), "int2");

        return Response.json({ url: "https://www.linkedin.com/oauth/v2/authorization?state=s" });
      }

      return Response.json({ posts: [row({ state: "PUBLISHED", releaseId: "native1" })] });
    },
  });

  const post: PlatformPostRef = {
    kind: "platform-post",
    version: 1,
    backend: "default",
    platform: "x",
    accountId: "int1",
    postId: "native1",
    native: { backendRecordId: `p1@${future}` },
  };

  const metrics = await adapter.analytics.getPostMetrics(post, context);

  assert.deepEqual(
    metrics.map((metric) => [metric.name, metric.value, metric.measuredAt, metric.source]),
    [
      ["impressions", 42, "2026-09-24T00:00:00.000Z", "postiz:x:analytics"],
      ["linkClicks", 3, "2026-09-24T00:00:00.000Z", "postiz:x:analytics"],
    ],
  );

  await assert.rejects(
    adapter.analytics.getPostMetrics({ ...post, postId: "other" }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );

  assert.deepEqual(
    await adapter.native.createConnectLink(
      { provider: "linkedin-page", refreshAccountId: "int2" },
      context,
    ),
    { url: "https://www.linkedin.com/oauth/v2/authorization?state=s" },
  );

  await assert.rejects(
    adapter.native.createConnectLink({ provider: "bluesky" }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Postiz builds the OAuth authorization URL for Cloud and self-hosted", () => {
  assert.equal(
    postizAuthorizationUrl({ clientId: "pca_client", state: "state 1" }),
    "https://platform.postiz.com/oauth/authorize?client_id=pca_client&response_type=code&state=state+1",
  );

  assert.equal(
    postizAuthorizationUrl({
      clientId: "pca_client",
      state: "s",
      frontendUrl: "https://postiz.example.com/",
    }),
    "https://postiz.example.com/oauth/authorize?client_id=pca_client&response_type=code&state=s",
  );

  for (const options of [
    { clientId: "pca_client", state: " " },
    { clientId: "", state: "s" },
    { clientId: "pca_client", state: "s", frontendUrl: "http://postiz.example.com" },
    { clientId: "pca_client", state: "s", frontendUrl: "https://user:pass@postiz.example.com" },
  ])
    assert.throws(
      () => postizAuthorizationUrl(options),
      (error) => error instanceof SocialError && error.code === "invalid_config",
    );
});

it("Postiz exchanges an authorization code for a workspace token", async () => {
  const calls: string[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      grant_type: "authorization_code",
      code: "code-1",
      client_id: "pca_client",
      client_secret: "pcs_secret",
    });

    return Response.json({
      id: "org1",
      cus: "cus_1",
      access_token: "pos_token",
      token_type: "bearer",
      scope: "*",
    });
  };

  const credentials = { clientId: "pca_client", clientSecret: "pcs_secret", code: "code-1", fetch };

  assert.deepEqual(await exchangePostizCode(credentials), {
    accessToken: "pos_token",
    organizationId: "org1",
    scope: "*",
  });

  await exchangePostizCode({
    ...credentials,
    baseUrl: "https://postiz.example.com/api/public/v1/",
  });

  assert.deepEqual(calls, [
    "https://api.postiz.com/oauth/token",
    "https://postiz.example.com/api/oauth/token",
  ]);
});

it("Postiz maps token exchange failures without echoing secrets", async () => {
  const exchange = (fetch: typeof globalThis.fetch) =>
    exchangePostizCode({
      clientId: "pca_client",
      clientSecret: "pcs_secret",
      code: "code-secret",
      fetch,
    });

  const cases: [typeof globalThis.fetch, string][] = [
    [async () => Response.json({ error: "invalid_client" }, { status: 401 }), "invalid_config"],
    [async () => Response.json({ error: "invalid_grant" }, { status: 400 }), "invalid_input"],
    [async () => Response.json({}, { status: 429 }), "rate_limited"],
    [async () => Response.json({}, { status: 502 }), "ambiguous_outcome"],
    [
      async () => {
        throw new TypeError("socket closed");
      },
      "ambiguous_outcome",
    ],
    [async () => Response.json({ access_token: "not-a-postiz-token" }), "upstream_failure"],
  ];

  for (const [fetch, code] of cases)
    await assert.rejects(exchange(fetch), (error) => {
      assert.ok(error instanceof SocialError);
      assert.equal(error.code, code);
      assert.doesNotMatch(JSON.stringify(error), /pcs_secret|code-secret|not-a-postiz-token/);
      assert.doesNotMatch(error.message, /pcs_secret|code-secret|not-a-postiz-token/);

      return true;
    });

  await assert.rejects(
    exchangePostizCode({ clientId: "pca_client", clientSecret: " ", code: "c" }),
    (error) => error instanceof SocialError && error.code === "invalid_config",
  );

  await assert.rejects(
    exchangePostizCode({ clientId: "pca_client", clientSecret: "pcs_secret", code: "" }),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});
