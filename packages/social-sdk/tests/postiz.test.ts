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
  MediaAttachment,
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

/** Postiz's public create gives each saved post a fresh uuidv4 group. */
const assignedGroup = "5e1f0c3a-8b2d-4f6e-9a7c-1d3b5f7e9a20";

const row = (fields: JsonObject): JsonObject => ({
  id: "p1",
  content: "hello",
  publishDate: future,
  releaseURL: null,
  releaseId: null,
  state: "QUEUE",
  group: assignedGroup,
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
        // An identifier this adapter does not map is skipped by default.
        { id: "int9", name: "Other", identifier: "other-network", profile: "o", disabled: false },
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
  // Postiz's public create assigns each saved post a fresh group (uuidv4) of its own.
  const assigned = "0d4f6a52-7c1e-4b8a-9f3d-2e6b1c8a5d70";

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
        posts: [
          row({ group: assigned, integration: { id: "int5", providerIdentifier: "tiktok" } }),
        ],
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
  // The job identifier carries the group Postiz assigned, which cancellation requires.
  assert.equal(
    outcome?.state === "scheduled" ? outcome.job.jobId : undefined,
    `p1@${future}~${assigned}`,
  );
  assert.deepEqual(calls, [
    "POST /public/v1/upload",
    "POST /public/v1/posts",
    "GET /public/v1/posts",
  ]);
});

it("Postiz stops oversized, stalled, and understated uploads before any request", async () => {
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

  // A stalled stream ends when the operation is aborted.
  const controller = new AbortController();
  let stalledCancelled = false;

  const stalled = new ReadableStream<Uint8Array>({
    cancel: () => {
      stalledCancelled = true;

      return new Promise<void>(() => undefined); // cleanup that never settles
    },
  });

  const upload = adapter.media.upload(
    {
      kind: "video",
      mimeType: "video/mp4",
      source: { kind: "stream", open: () => stalled, fingerprint: "stalled" },
    },
    x,
    { ...context, signal: controller.signal },
  );

  controller.abort();
  await assert.rejects(
    upload,
    (error) => error instanceof SocialError && error.code === "cancelled",
  );
  assert.equal(stalledCancelled, true);

  // The Blob's real size wins over a smaller declared byteSize.
  await assert.rejects(
    adapter.media.upload(
      {
        kind: "image",
        mimeType: "image/png",
        byteSize: 1,
        source: blob(10 * 1024 * 1024 + 1),
      },
      x,
      context,
    ),
    (error) => error instanceof SocialError && error.code === "media_error",
  );
  assert.equal(calls, 0);
});

it("Postiz publishes now and reports an unexpected response as ambiguous", async () => {
  let response: JsonValue = [{ postId: "p1", integration: "other" }];
  let listed = row({ publishDate: "2026-09-24T12:00:00.000Z" });
  let readFails = false;

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

      if (readFails) return Response.json({ message: "unavailable" }, { status: 503 });

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

  // A failed follow-up read preserves acceptance without inventing queue evidence.
  readFails = true;
  const unread = (await social.posts.publish(request)).outcomes[0];

  assert.equal(unread?.state, "accepted");
  assert.equal(
    unread?.state === "accepted" ? unread.delivery?.deliveryId : undefined,
    `p1@2026-09-24T12:00:00.000Z`,
  );
  readFails = false;

  // The follow-up read finds the created post on another channel.
  listed = row({ publishDate: "2026-09-24T12:00:00.000Z", integration: { id: "other" } });
  const misplaced = (await social.posts.publish(request)).outcomes[0];

  assert.equal(misplaced?.state, "unknown");
  assert.equal(misplaced?.delivery, undefined);
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
    jobId: `p1@${future}~${assignedGroup}`,
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

  // Another post shares the group, so deleting by group would remove it too.
  posts = [row({}), row({ id: "p2", integration: { id: "int2" } })];
  await assert.rejects(
    adapter.posts.cancelScheduled(job, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );

  // A listing identifier names no group, so it cannot show this adapter saved the post.
  posts = [row({})];
  await assert.rejects(
    adapter.posts.cancelScheduled({ ...job, jobId: `p1@${future}` }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );

  // Postiz rotated the group, as a dashboard edit does, so the identifier is stale.
  posts = [row({ group: "AbCdEfGh12" })];
  await assert.rejects(
    adapter.posts.cancelScheduled(job, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );

  await assert.rejects(
    adapter.posts.cancelScheduled({ ...job, jobId: `p1@${future}~../other` }, context),
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

  const record = {
    kind: "backend-post" as const,
    version: 1 as const,
    backend: "default",
    platform: "x" as const,
    accountId: "int1",
    recordId: `p1@${future}~${assignedGroup}`,
  };

  posts = [row({ state: "PUBLISHED", releaseId: "n1" })];
  await assert.rejects(
    adapter.posts.deleteBackendRecord(record, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );

  posts = [row({ state: "DRAFT" })];
  await assert.rejects(
    adapter.posts.deleteBackendRecord({ ...record, recordId: `p1@${future}` }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
  assert.deepEqual(methods, ["GET", "GET", "GET", "GET", "GET", "GET", "GET"]);

  deleted = { id: "p1" };
  await adapter.posts.deleteBackendRecord(record, context);
  assert.deepEqual(methods.slice(-2), ["GET", "DELETE"]);
});

/**
 * A fake that follows Postiz's public API source (gitroomhq/postiz-app at bd8353f):
 * `POST /posts` drops any `group` the client sends and saves each post with a fresh uuidv4
 * group, also on an edit, and `DELETE /posts/:id` deletes the post's whole group.
 */
function groupingPostiz() {
  const posts: JsonObject[] = [];
  const deletes: string[] = [];
  let created = 0;

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";

    if (method === "POST") {
      const item = object(array(object(JSON.parse(String(init?.body)))["posts"])[0]);
      const value = object(array(item["value"])[0]);
      const existing = posts.find((post) => post["id"] === value["id"]);
      const group = crypto.randomUUID();

      if (existing) {
        Object.assign(existing, { content: string(value["content"]), group });

        return Response.json([{ postId: existing["id"], integration: "int1" }], { status: 201 });
      }

      created++;
      posts.push(
        row({
          id: `p${created}`,
          content: string(value["content"]),
          group,
          // Postiz stores the settings as a JSON string.
          settings: JSON.stringify(object(item["settings"])),
        }),
      );

      return Response.json([{ postId: `p${created}`, integration: "int1" }], { status: 201 });
    }

    if (method === "DELETE") {
      const id = url.pathname.split("/").at(-1);
      const group = posts.find((post) => post["id"] === id)?.["group"];
      const first = posts.find((post) => post["group"] === group);

      deletes.push(String(id));

      for (let index = posts.length - 1; index >= 0; index--)
        if (posts[index]?.["group"] === group) posts.splice(index, 1);

      return Response.json(first === undefined ? null : { id: first["id"] });
    }

    return Response.json({ posts });
  };

  return { posts, deletes, fetch };
}

it("Postiz cancels a post it published and edited, using the group Postiz assigned", async () => {
  const fake = groupingPostiz();
  const adapter = postiz({ apiKey: "test", clock, fetch: fake.fetch });

  const published = await createSocial({ backend: adapter, clock }).posts.publish({
    targets: [{ account: x }],
    content: { text: "First" },
    schedule: { at: future },
  });

  const outcome = published.outcomes[0];
  const first = fake.posts[0]?.["group"];

  assert.equal(outcome?.state, "scheduled");
  assert.equal(
    outcome?.state === "scheduled" ? outcome.job.jobId : undefined,
    `p1@${future}~${String(first)}`,
  );

  if (outcome?.state !== "scheduled") return;

  // The adapter never sends a group; Postiz would read one as a group to replace.
  const edited = await adapter.native.editPost(outcome.job, { text: "Second", media: [] }, context);
  const second = fake.posts[0]?.["group"];

  assert.notEqual(second, first);
  assert.equal(edited.state, "scheduled");

  if (edited.state !== "scheduled") return;

  assert.equal(edited.job.jobId, `p1@${future}~${String(second)}`);

  // The identifier from before the edit names a group Postiz has since replaced.
  await assert.rejects(
    adapter.posts.cancelScheduled(outcome.job, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
  assert.deepEqual(fake.deletes, []);

  assert.deepEqual(await adapter.posts.cancelScheduled(edited.job, context), {
    state: "cancelled",
    backendRecord: "deleted",
  });
  assert.deepEqual(fake.deletes, ["p1"]);
  assert.deepEqual(fake.posts, []);
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
    metrics.map((metric) => metric.canonicalName),
    ["impressions", "clicks"],
  );

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

it("Postiz sends a Reddit video thumbnail and allows one Reddit attachment", async () => {
  const reddit = connectedAccountRef({ backend: "default", platform: "reddit", accountId: "red1" });
  const sent: JsonObject[] = [];

  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/upload-from-url"))
        return Response.json({ id: "m1", path: "https://uploads.postiz.com/m1.mp4" });

      if (init?.method === "POST") {
        sent.push(object(JSON.parse(String(init.body))));

        return Response.json([{ postId: "p1", integration: "red1" }], { status: 201 });
      }

      return Response.json({
        posts: [row({ integration: { id: "red1", providerIdentifier: "reddit" } })],
      });
    },
  });

  const social = createSocial({ backend: adapter, clock });
  const options = { subreddit: "typescript", title: "Demo" };

  const video = {
    kind: "video" as const,
    mimeType: "video/mp4",
    source: { kind: "https-url" as const, url: "https://cdn.example.com/clip.mp4" },
  };

  const image = {
    kind: "image" as const,
    mimeType: "image/png",
    source: { kind: "https-url" as const, url: "https://cdn.example.com/a.png" },
  };

  const codes = (media: readonly MediaAttachment[]) =>
    social.posts
      .prepare({ targets: [{ account: reddit, options }], content: { text: "hi", media } })
      .issues.map((issue) => issue.code);

  assert.ok(codes([video]).includes("reddit.video_thumbnail_required"));
  assert.ok(
    codes([
      { ...video, thumbnail: { kind: "https-url", url: "https://cdn.example.com/poster" } },
    ]).includes("reddit.video_thumbnail_source"),
  );
  assert.ok(codes([image, image]).includes("reddit.media_count"));
  assert.ok(
    codes([
      { ...image, thumbnail: { kind: "https-url", url: "https://cdn.example.com/p.png" } },
    ]).includes("media.thumbnail_unsupported"),
  );

  const formats = adapter.capabilities.capabilities.find(
    (entry) => entry.platform === "reddit" && entry.operation === "posts.publish",
  )?.formats;

  assert.deepEqual(formats, ["text", "image", "video"]);

  const result = await social.posts.publish({
    targets: [{ account: reddit, options }],
    content: {
      text: "hi",
      media: [{ ...video, thumbnail: { kind: "https-url", url: "https://cdn.example.com/p.jpg" } }],
    },
    schedule: { at: future },
  });

  assert.equal(result.outcomes[0]?.state, "scheduled");

  const [post] = array(sent[0]?.["posts"] ?? []);
  const [value] = array(object(post ?? {})["value"] ?? []);

  assert.deepEqual(object(value ?? {})["image"], [
    {
      id: "m1",
      path: "https://uploads.postiz.com/m1.mp4",
      thumbnail: "https://cdn.example.com/p.jpg",
    },
  ]);
});

it("Postiz rejects Twitch media and long messages before any upload", async () => {
  const twitch = connectedAccountRef({ backend: "default", platform: "twitch", accountId: "tw1" });
  let requests = 0;

  const social = createSocial({
    backend: postiz({
      apiKey: "test",
      clock,
      fetch: async () => {
        requests += 1;

        return Response.json({});
      },
    }),
    clock,
  });

  const codes = (content: Parameters<typeof social.posts.prepare>[0]["content"]) =>
    social.posts.prepare({ targets: [{ account: twitch }], content }).issues.map((i) => i.code);

  assert.deepEqual(codes({ text: "x".repeat(500) }), []);
  assert.ok(codes({ text: "x".repeat(501) }).includes("twitch.text_too_long"));
  assert.ok(
    codes({
      text: "clip",
      media: [{ kind: "video", mimeType: "video/mp4", filename: "a.mp4", source: blob(1) }],
    }).includes("twitch.media_unsupported"),
  );

  await assert.rejects(
    social.posts.publish({
      targets: [{ account: twitch }],
      content: {
        text: "look",
        media: [{ kind: "image", mimeType: "image/png", filename: "a.png", source: blob(1) }],
      },
    }),
    { code: "invalid_input" },
  );
  assert.equal(requests, 0);
});

it("Postiz publishes a Reddit link post with a title and no commentary", async () => {
  const reddit = connectedAccountRef({ backend: "default", platform: "reddit", accountId: "red1" });
  const sent: JsonObject[] = [];

  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async (_input, init) => {
      if (init?.method === "POST") {
        sent.push(object(JSON.parse(String(init.body))));

        return Response.json([{ postId: "p1", integration: "red1" }], { status: 201 });
      }

      return Response.json({
        posts: [row({ integration: { id: "red1", providerIdentifier: "reddit" } })],
      });
    },
  });

  const social = createSocial({ backend: adapter, clock });

  const request = {
    targets: [{ account: reddit, options: { subreddit: "typescript", title: "Read this" } }],
    content: { link: { url: "https://example.com/article" } },
  };

  assert.deepEqual(social.posts.prepare(request).issues, []);
  await social.posts.publish(request);

  const [post] = array(sent[0]?.["posts"] ?? []);
  const settings = object(object(post ?? {})["settings"] ?? {});
  const [entry] = array(settings["subreddit"] ?? []);
  const value = object(object(entry ?? {})["value"] ?? {});

  assert.equal(value["type"], "link");
  assert.equal(value["url"], "https://example.com/article");
});
