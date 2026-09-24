import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { postfast } from "../src/cloud/postfast.js";
import { SocialError } from "../src/core/errors.js";
import type { AdapterOperationContext, JsonObject, PlatformPostRef } from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-09-24T12:00:00.000Z");

const future = "2026-09-25T09:00:00.000Z";

const x = connectedAccountRef({ backend: "default", platform: "x", accountId: "sm1" });

const youtube = connectedAccountRef({
  backend: "default",
  platform: "youtube",
  accountId: "sm2",
});

const bluesky = connectedAccountRef({
  backend: "default",
  platform: "bluesky",
  accountId: "sm4",
});

const tiktok = connectedAccountRef({
  backend: "default",
  platform: "tiktok",
  accountId: "sm5",
});

const row = (fields: JsonObject): JsonObject => ({
  id: "p1",
  content: "hello",
  status: "SCHEDULED",
  approvalStatus: "APPROVED",
  socialMediaId: "sm1",
  scheduledAt: future,
  publishedAt: null,
  platformPostId: null,
  ...fields,
});

it("PostFast sends its API key header and maps supported accounts", async () => {
  const adapter = postfast({
    apiKey: "test",
    clock,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);

      assert.equal(url.origin, "https://api.postfa.st");
      assert.equal(url.pathname, "/social-media/my-social-accounts");
      assert.equal(headers.get("pf-api-key"), "test");
      assert.equal(headers.get("authorization"), null);

      return Response.json([
        {
          id: "sm1",
          platform: "X",
          platformUsername: "demo",
          displayName: "Demo",
          connectionStatus: "CONNECTED",
        },
        { id: "sm3", platform: "PINTEREST", platformUsername: "pins" },
        {
          id: "sm2",
          platform: "YOUTUBE",
          platformUsername: "channel",
          displayName: "Channel",
          connectionStatus: "DISABLED",
          disabledReason: "TOKEN_REVOKED",
        },
      ]);
    },
  });

  const page = await adapter.accounts.list({ limit: 1 }, context);

  assert.deepEqual(
    page.items.map((item) => [item.ref.platform, item.ref.accountId, item.status]),
    [["x", "sm1", "connected"]],
  );
  assert.equal(page.nextCursor, "1");

  const next = await adapter.accounts.list({ cursor: "1", limit: 1 }, context);

  assert.deepEqual(
    next.items.map((item) => [item.ref.platform, item.status]),
    [["youtube", "reconnect-required"]],
  );
  assert.equal(next.nextCursor, undefined);
  assert.equal((await adapter.accounts.get(x, context)).displayName, "Demo");
});

it("PostFast requires a future schedule and uploaded media", () => {
  const social = createSocial({
    backend: postfast({ apiKey: "test", clock, fetch: async () => Response.json({}) }),
  });

  const codes = (request: Parameters<typeof social.posts.prepare>[0]) =>
    social.posts.prepare(request).issues.map((issue) => issue.code);

  assert.ok(
    codes({ targets: [{ account: x }], content: { text: "hi" } }).includes("schedule.required"),
  );
  assert.ok(
    codes({
      targets: [{ account: x }],
      content: { text: "hi" },
      schedule: { at: "2026-09-24T11:00:00.000Z" },
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
            source: { kind: "https-url", url: "https://example.com/a.png" },
          },
        ],
      },
      schedule: { at: future },
    }).includes("media.url_unsupported"),
  );
  assert.ok(
    codes({
      targets: [{ account: bluesky }],
      content: {
        text: "hi",
        media: [
          {
            kind: "video",
            mimeType: "video/mp4",
            source: { kind: "blob", blob: new Blob([new Uint8Array(1)]), fingerprint: "v" },
          },
        ],
      },
      schedule: { at: future },
    }).includes("bluesky.video_unsupported"),
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
            source: { kind: "blob", blob: new Blob([new Uint8Array(1)]), fingerprint: "d" },
          },
        ],
      },
      schedule: { at: future },
    }).includes("media.document_unsupported"),
  );
  assert.ok(
    !codes({
      targets: [{ account: x }],
      content: {
        text: "hi",
        media: [
          {
            kind: "video",
            mimeType: "video/mov",
            source: { kind: "blob", blob: new Blob([new Uint8Array(1)]), fingerprint: "m" },
          },
        ],
      },
      schedule: { at: future },
    }).includes("media.mime_unsupported"),
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
            source: {
              kind: "blob",
              blob: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]),
              fingerprint: "big",
            },
          },
        ],
      },
      schedule: { at: future },
    }).includes("media.too_large"),
  );

  const tiktokVideo = (draft: boolean) =>
    codes({
      targets: [{ account: tiktok, options: { privacy: "SELF_ONLY", draft } }],
      content: {
        text: "hi",
        media: [
          {
            kind: "video",
            mimeType: "video/mp4",
            source: { kind: "blob", blob: new Blob([new Uint8Array(1)]), fingerprint: "t" },
          },
        ],
      },
      schedule: { at: future },
    });

  assert.ok(!tiktokVideo(true).includes("tiktok.privacy_unsupported"));
  assert.ok(tiktokVideo(false).includes("tiktok.privacy_unsupported"));
  assert.deepEqual(
    postfast({
      apiKey: "test",
      fetch: async () => Response.json({}),
    }).capabilities.capabilities.find(
      (entry) => entry.platform === "bluesky" && entry.operation === "posts.publish",
    )?.formats,
    ["text", "image", "carousel"],
  );
  assert.equal(
    social.posts.prepare({
      targets: [{ account: x }],
      content: { text: "hi" },
      schedule: { at: future },
    }).ok,
    true,
  );
});

it("PostFast uploads by key, schedules the post and maps YouTube controls", async () => {
  const calls: string[] = [];

  const adapter = postfast({
    apiKey: "test",
    clock,
    uploadHostAllowed: (hostname) => hostname === "storage.example.test",
    fetch: async (input, init) => {
      const url = new URL(String(input));

      calls.push(`${init?.method ?? "GET"} ${url.hostname}${url.pathname}`);

      if (url.hostname === "storage.example.test") {
        assert.equal(new Headers(init?.headers).get("pf-api-key"), null);
        assert.equal(init?.method, "PUT");

        return new Response(null, { status: 200 });
      }

      if (url.pathname === "/file/get-signed-upload-urls") {
        assert.deepEqual(JSON.parse(String(init?.body)), { contentType: "video/mp4", count: 1 });

        return Response.json(
          [{ key: "video/v1.mp4", signedUrl: "https://storage.example.test/video/v1.mp4?sig=1" }],
          { status: 201 },
        );
      }

      if (url.pathname === "/social-posts" && init?.method === "POST") {
        assert.deepEqual(JSON.parse(String(init.body)), {
          posts: [
            {
              content: "demo",
              socialMediaId: "sm2",
              scheduledAt: future,
              mediaItems: [{ key: "video/v1.mp4", type: "VIDEO", sortOrder: 0 }],
            },
          ],
          status: "SCHEDULED",
          controls: {
            youtubeTitle: "Demo",
            youtubePrivacy: "PRIVATE",
            youtubeMadeForKids: false,
          },
        });

        return Response.json({ postIds: ["p1"] }, { status: 201 });
      }

      assert.equal(url.searchParams.get("ids"), "p1");

      return Response.json({ data: [row({ socialMediaId: "sm2" })], totalCount: 1 });
    },
  });

  const result = await createSocial({ backend: adapter }).posts.publish({
    targets: [
      {
        account: youtube,
        options: { title: "Demo", visibility: "private", madeForKids: false },
      },
    ],
    content: {
      text: "demo",
      media: [
        {
          kind: "video",
          mimeType: "video/mp4",
          filename: "demo.mp4",
          source: { kind: "blob", blob: new Blob([new Uint8Array(100)]), fingerprint: "v" },
        },
      ],
    },
    schedule: { at: future },
  });

  const outcome = result.outcomes[0];

  assert.equal(outcome?.state, "scheduled");
  assert.equal(outcome?.state === "scheduled" ? outcome.job.jobId : undefined, "p1");
  assert.deepEqual(calls, [
    "POST api.postfa.st/file/get-signed-upload-urls",
    "PUT storage.example.test/video/v1.mp4",
    "POST api.postfa.st/social-posts",
    "GET api.postfa.st/social-posts",
  ]);
});

it("PostFast maps delivery states and refuses another account's record", async () => {
  let current = row({});

  const adapter = postfast({
    apiKey: "test",
    clock,
    fetch: async () => Response.json({ data: [current], totalCount: 1 }),
  });

  const ref = { deliveryId: "p1", accountId: "sm1", platform: "x", backend: "default" };

  assert.equal((await adapter.posts.getDelivery(ref, context)).state, "scheduled");

  current = row({ approvalStatus: "PENDING_APPROVAL" });
  assert.equal((await adapter.posts.getDelivery(ref, context)).state, "accepted");

  current = row({ status: "PUBLISHED", publishedAt: future, platformPostId: "native1" });
  const published = await adapter.posts.getDelivery(ref, context);

  assert.equal(published.state, "published");
  assert.deepEqual(published.state === "published" ? published.post.native : undefined, {
    backendRecordId: "p1",
  });

  current = row({ status: "PUBLISHED" });
  assert.equal((await adapter.posts.getDelivery(ref, context)).state, "unknown");

  current = row({ status: "FAILED", lastError: "private detail" });
  const failed = await adapter.posts.getDelivery(ref, context);

  assert.equal(failed.state, "failed");
  assert.ok(!JSON.stringify(failed).includes("private detail"));

  current = row({ socialMediaId: "other" });
  await assert.rejects(
    adapter.posts.getDelivery(ref, context),
    (error) => error instanceof SocialError && error.code === "unauthorized",
  );
});

it("PostFast cancels only future scheduled posts and requires deletion confirmation", async () => {
  let current = row({});
  let deleted = true;
  const methods: string[] = [];

  const adapter = postfast({
    apiKey: "test",
    clock,
    fetch: async (input, init) => {
      methods.push(init?.method ?? "GET");

      if (init?.method === "DELETE") {
        assert.equal(new URL(String(input)).pathname, "/social-posts/p1");

        return Response.json({ deleted });
      }

      return Response.json({ data: [current], totalCount: 1 });
    },
  });

  const job = {
    kind: "scheduled-job" as const,
    version: 1 as const,
    backend: "default",
    platform: "x" as const,
    accountId: "sm1",
    jobId: "p1",
  };

  assert.deepEqual(await adapter.posts.cancelScheduled(job, context), {
    state: "cancelled",
    backendRecord: "deleted",
  });

  deleted = false;
  await assert.rejects(
    adapter.posts.cancelScheduled(job, context),
    (error) => error instanceof SocialError && error.code === "ambiguous_outcome",
  );

  methods.length = 0;
  current = row({ scheduledAt: "2026-09-24T11:00:00.000Z" });
  await assert.rejects(
    adapter.posts.cancelScheduled(job, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
  assert.deepEqual(methods, ["GET"]);

  current = row({ status: "PUBLISHED" });
  await assert.rejects(
    adapter.posts.deleteBackendRecord(
      {
        kind: "backend-post",
        version: 1,
        backend: "default",
        platform: "x",
        accountId: "sm1",
        recordId: "p1",
      },
      context,
    ),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("PostFast reads analytics around the publish time and parses bigint counters", async () => {
  const adapter = postfast({
    apiKey: "test",
    clock,
    fetch: async (input) => {
      const url = new URL(String(input));

      if (url.pathname === "/social-posts")
        return Response.json({
          data: [
            row({
              status: "PUBLISHED",
              publishedAt: "2026-09-20T10:00:00.000Z",
              platformPostId: "native1",
            }),
          ],
        });

      assert.equal(url.pathname, "/social-posts/analytics");
      assert.equal(url.searchParams.get("startDate"), "2026-09-19T10:00:00.000Z");
      assert.equal(url.searchParams.get("endDate"), "2026-09-21T10:00:00.000Z");
      assert.equal(url.searchParams.get("socialMediaIds"), "sm1");

      return Response.json({
        data: [
          {
            id: "p1",
            socialMediaId: "sm1",
            platformPostId: "native1",
            latestMetric: {
              likes: "12",
              comments: "3",
              impressions: "99999999999999999999",
              reach: null,
              videoViews: 40,
              avgWatchTimeSeconds: 4.5,
            },
          },
        ],
      });
    },
  });

  const ref: PlatformPostRef = {
    kind: "platform-post",
    version: 1,
    backend: "default",
    platform: "x",
    accountId: "sm1",
    postId: "native1",
    native: { backendRecordId: "p1" },
  };

  const metrics = await adapter.analytics.getPostMetrics(ref, context);

  assert.deepEqual(
    metrics.map((metric) => [metric.name, metric.value, metric.unit]),
    [
      ["likes", 12, "count"],
      ["comments", 3, "count"],
      ["views", 40, "count"],
      ["averageWatchTime", 4.5, "seconds"],
    ],
  );

  await assert.rejects(
    adapter.analytics.getPostMetrics({ ...ref, native: {} }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("PostFast connect links validate platforms and return the hosted URL", async () => {
  const adapter = postfast({
    apiKey: "test",
    fetch: async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { platforms: ["X"], expiryDays: 3 });

      return Response.json({ connectUrl: "https://app.postfa.st/connect/abc" });
    },
  });

  assert.deepEqual(
    await adapter.native.createConnectLink({ platforms: ["X"], expiryDays: 3 }, context),
    { url: "https://app.postfa.st/connect/abc" },
  );
  await assert.rejects(
    adapter.native.createConnectLink({ platforms: ["PINTEREST"] }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("PostFast reports a created post owned by another account as an uncertain write", async () => {
  const adapter = postfast({
    apiKey: "test",
    clock,
    fetch: async (input, init) => {
      if (init?.method === "POST") return Response.json({ postIds: ["p1"] }, { status: 201 });

      assert.equal(new URL(String(input)).searchParams.get("ids"), "p1");

      return Response.json({ data: [row({ socialMediaId: "other" })], totalCount: 1 });
    },
  });

  const result = await createSocial({ backend: adapter }).posts.publish({
    targets: [{ account: x }],
    content: { text: "demo" },
    schedule: { at: future },
  });

  const outcome = result.outcomes[0];

  assert.equal(outcome?.state, "unknown");
  assert.equal(outcome?.state === "unknown" ? outcome.reason : undefined, "ambiguous-submission");
});

it("PostFast rejects an oversized blob before requesting an upload URL", async () => {
  let calls = 0;

  const social = createSocial({
    backend: postfast({
      apiKey: "test",
      fetch: async () => {
        calls += 1;

        return Response.json([]);
      },
    }),
  });

  await assert.rejects(
    social.media.upload(
      {
        kind: "image",
        mimeType: "image/png",
        source: {
          kind: "blob",
          blob: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]),
          fingerprint: "big",
        },
      },
      x,
    ),
    { name: "SocialError", code: "media_error" },
  );
  assert.equal(calls, 0);
});

it("PostFast does not submit a schedule that passed during media upload", async () => {
  let time = clock().getTime();
  const calls: string[] = [];

  const adapter = postfast({
    apiKey: "test",
    clock: () => new Date(time),
    uploadHostAllowed: (hostname) => hostname === "storage.example.test",
    fetch: async (input, init) => {
      const url = new URL(String(input));

      calls.push(`${init?.method ?? "GET"} ${url.hostname}${url.pathname}`);

      if (url.hostname === "storage.example.test") {
        time = Date.parse(future) + 1;

        return new Response(null, { status: 200 });
      }

      return Response.json(
        [{ key: "image/i1.png", signedUrl: "https://storage.example.test/image/i1.png?sig=1" }],
        { status: 201 },
      );
    },
  });

  const result = await createSocial({ backend: adapter }).posts.publish({
    targets: [{ account: x }],
    content: {
      text: "demo",
      media: [
        {
          kind: "image",
          mimeType: "image/png",
          filename: "i.png",
          source: { kind: "blob", blob: new Blob([new Uint8Array(10)]), fingerprint: "i" },
        },
      ],
    },
    schedule: { at: future },
  });

  assert.equal(result.outcomes[0]?.state, "failed");
  assert.deepEqual(calls, [
    "POST api.postfa.st/file/get-signed-upload-urls",
    "PUT storage.example.test/image/i1.png",
  ]);
});
