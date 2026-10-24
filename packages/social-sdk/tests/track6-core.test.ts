import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SocialError,
  bytes,
  connectedAccountRef,
  createSocial,
  defineAdapter,
  platformPostRef,
  type AuthorizationPolicy,
  type CapabilityDeclaration,
  type DeliveryOutcome,
  type JsonObject,
  type MediaAttachment,
  type MediaStagingProvider,
  type Page,
  type PreparedPublishTarget,
} from "../src/index.js";
import { MemoryIdempotencyStore } from "../src/testing/index.js";
import { tiktok } from "../src/platforms/tiktok.js";

const account = connectedAccountRef({ backend: "default", platform: "instagram", accountId: "a1" });

function publishAdapter(input: {
  readonly declarations: readonly CapabilityDeclaration[];
  readonly publish?: (target: PreparedPublishTarget) => DeliveryOutcome;
  readonly prepared?: PreparedPublishTarget[];
  readonly published?: PreparedPublishTarget[];
}) {
  return defineAdapter({
    id: "fixture",
    capabilities: {
      schemaVersion: 1,
      backend: "fixture",
      apiRevision: "fixture-v1",
      runtime: ["node"],
      capabilities: input.declarations,
    },
    posts: {
      prepareTarget(target) {
        input.prepared?.push(target);
        const issues = [];

        for (const item of target.content.media ?? [])
          if (item.source.kind !== "https-url")
            issues.push({
              code: "fixture.source",
              message: "URL only",
              severity: "error" as const,
              targetIndex: target.targetIndex,
            });

        return issues;
      },
      async publishTarget(target) {
        input.published?.push(target);

        return (
          input.publish?.(target) ?? {
            state: "published",
            targetIndex: target.targetIndex,
            account: target.account,
            observedAt: "2026-10-24T00:00:00.000Z",
            post: platformPostRef({ ...target.account, postId: "p1" }),
          }
        );
      },
    },
  });
}

const urlOnly: CapabilityDeclaration = {
  operation: "posts.publish",
  platform: "instagram",
  availability: "available",
  formats: ["image", "video", "carousel"],
  constraints: { mediaSources: ["https-url"] },
};

function image(fill: number, extra: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    kind: "image",
    source: {
      kind: "blob",
      blob: new Blob([new Uint8Array([fill, fill, fill])], { type: "image/jpeg" }),
      fingerprint: `fixture-${fill}`,
    },
    mimeType: "image/jpeg",
    ...extra,
  };
}

function stagingFixture(options: { failOn?: number; url?: (call: number) => string } = {}) {
  const staged: string[] = [];
  const cleaned: string[] = [];
  let calls = 0;

  const provider: MediaStagingProvider = {
    origin: "https://media.example.com",
    async stageMedia(source) {
      const call = ++calls;

      if (call === options.failOn)
        throw new Error("upload to https://bucket.example.com/?X-Signature=secret failed");
      const fingerprint = source.kind === "blob" ? source.fingerprint : "other";
      staged.push(fingerprint);

      return {
        url: options.url?.(call) ?? `https://media.example.com/${call}?sig=secret`,
        cleanup: async () => {
          cleaned.push(fingerprint);
        },
      };
    },
  };

  return { provider, staged, cleaned, calls: () => calls };
}

describe("bytes()", () => {
  test("fingerprints content deterministically and copies the caller's buffer", async () => {
    const data = new TextEncoder().encode("abc");
    const source = await bytes(data, { mimeType: "image/png" });

    assert.equal(
      source.fingerprint,
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    assert.equal((await bytes(data.buffer.slice(0))).fingerprint, source.fingerprint);
    assert.equal(source.blob.type, "image/png");
    data[0] = 0;
    assert.equal(new TextDecoder().decode(await source.blob.arrayBuffer()), "abc");
    assert.equal((await bytes(data, { fingerprint: "caller-id" })).fingerprint, "caller-id");
  });
});

describe("capability media constraints in posts.prepare", () => {
  test("reports item count, actual blob size, MIME, aspect ratio and video duration", () => {
    const social = createSocial({
      backend: publishAdapter({
        declarations: [
          {
            operation: "posts.publish",
            platform: "*",
            availability: "available",
            constraints: {
              maxItems: 2,
              maxBytes: 2,
              allowedMimeTypes: ["image/*", "video/mp4"],
              aspectRatioRange: [0.8, 1.91],
              maxDurationSeconds: 60,
            },
          },
        ],
      }),
    });

    const plan = social.posts.prepare({
      targets: [{ account }],
      content: {
        media: [
          image(1, { byteSize: 2 }),
          {
            kind: "document",
            source: { kind: "https-url", url: "https://a.example/x.pdf" },
            mimeType: "application/pdf",
            width: 10,
            height: 1,
          },
          {
            kind: "video",
            source: { kind: "https-url", url: "https://a.example/v.mp4" },
            mimeType: "video/mp4",
            durationSeconds: 61,
            width: 100,
            height: 100,
          },
          {
            kind: "image",
            source: { kind: "https-url", url: "https://a.example/i.jpg" },
            width: 300,
            height: 100,
          },
        ],
      },
    });

    assert.equal(plan.ok, false);
    assert.deepEqual(
      plan.issues
        .filter((issue) => issue.code.startsWith("media."))
        .map((issue) => [issue.code, issue.path]),
      [
        ["media.too_many", "content.media"],
        ["media.size_mismatch", "content.media[0].byteSize"],
        ["media.too_large", "content.media[0].byteSize"],
        ["media.mime_unsupported", "content.media[1].mimeType"],
        ["media.too_long", "content.media[2].durationSeconds"],
        ["media.aspect_ratio", "content.media[3]"],
      ],
    );
  });

  test("selects constraints by content format when a platform declares several", () => {
    const declarations: CapabilityDeclaration[] = [
      {
        operation: "posts.publish",
        platform: "tiktok",
        availability: "available",
        formats: ["video"],
        constraints: { maxDurationSeconds: 600 },
      },
      {
        operation: "posts.publish",
        platform: "tiktok",
        availability: "available",
        formats: ["image", "carousel"],
        constraints: { maxItems: 1 },
      },
    ];

    const social = createSocial({ backend: publishAdapter({ declarations }) });
    const tiktok = connectedAccountRef({ backend: "default", platform: "tiktok", accountId: "t1" });
    const url = { kind: "https-url" as const, url: "https://a.example/i.jpg" };

    const photos = social.posts.prepare({
      targets: [{ account: tiktok }],
      content: {
        media: [
          { kind: "image", source: url },
          { kind: "image", source: url },
        ],
      },
    });

    const video = social.posts.prepare({
      targets: [{ account: tiktok }],
      content: { media: [{ kind: "video", source: url, durationSeconds: 300 }] },
    });

    assert.deepEqual(
      photos.issues.map((issue) => issue.code),
      ["media.too_many"],
    );
    assert.equal(video.ok, true);
  });

  test("rejects local media for URL-only targets unless staging is configured", () => {
    const without = createSocial({ backend: publishAdapter({ declarations: [urlOnly] }) });

    const rejected = without.posts.prepare({
      targets: [{ account }],
      content: { media: [image(1)] },
    });

    assert.ok(rejected.issues.some((issue) => issue.code === "media.source_unsupported"));

    const prepared: PreparedPublishTarget[] = [];

    const social = createSocial({
      backend: publishAdapter({ declarations: [urlOnly], prepared }),
      mediaStaging: stagingFixture().provider,
    });

    const media = image(1);
    const plan = social.posts.prepare({ targets: [{ account }], content: { media: [media] } });

    assert.equal(plan.ok, true);
    assert.equal(plan.targets[0]?.content.media?.[0]?.source, media.source);
    assert.deepEqual(prepared[0]?.content.media?.[0]?.source, {
      kind: "https-url",
      url: "https://media.example.com/social-sdk-staging/0",
    });
  });

  test("rejects an invalid staging origin at construction", () => {
    assert.throws(
      () =>
        createSocial({
          backend: publishAdapter({ declarations: [urlOnly] }),
          mediaStaging: {
            origin: "http://media.example.com/path",
            stageMedia: async () => ({ url: "" }),
          },
        }),
      (error) => error instanceof SocialError && error.code === "invalid_config",
    );
  });
});

describe("media staging during publish", () => {
  test("publishes staged URLs and removes copies after a published outcome", async () => {
    const published: PreparedPublishTarget[] = [];
    const staging = stagingFixture();

    const social = createSocial({
      backend: publishAdapter({ declarations: [urlOnly], published }),
      mediaStaging: staging.provider,
    });

    const media = [image(1), image(2)];

    const result = await social.posts.publish({ targets: [{ account }], content: { media } });

    assert.equal(result.outcomes[0]?.state, "published");
    assert.deepEqual(
      published[0]?.content.media?.map((item) => item.source),
      [
        { kind: "https-url", url: "https://media.example.com/1?sig=secret" },
        { kind: "https-url", url: "https://media.example.com/2?sig=secret" },
      ],
    );
    assert.deepEqual(staging.cleaned, staging.staged);
    assert.equal(staging.cleaned.length, 2);
  });

  test("keeps staged copies while the provider may still fetch them", async () => {
    for (const state of ["processing", "accepted", "unknown"] as const) {
      const staging = stagingFixture();

      const social = createSocial({
        backend: publishAdapter({
          declarations: [urlOnly],
          publish: (target): DeliveryOutcome =>
            state === "unknown"
              ? {
                  state,
                  targetIndex: target.targetIndex,
                  account: target.account,
                  observedAt: "t",
                  reason: "ambiguous-submission",
                }
              : {
                  state,
                  targetIndex: target.targetIndex,
                  account: target.account,
                  observedAt: "t",
                },
        }),
        mediaStaging: staging.provider,
      });

      const result = await social.posts.publish({
        targets: [{ account }],
        content: { media: [image(1)] },
      });

      assert.equal(result.outcomes[0]?.state, state);
      assert.equal(staging.staged.length, 1);
      assert.deepEqual(staging.cleaned, []);
    }
  });

  test("a partial staging failure stops before submission, cleans up, and hides signed URLs", async () => {
    const published: PreparedPublishTarget[] = [];
    const staging = stagingFixture({ failOn: 2 });

    const social = createSocial({
      backend: publishAdapter({ declarations: [urlOnly], published }),
      mediaStaging: staging.provider,
    });

    const result = await social.posts.publish({
      targets: [{ account }],
      content: { media: [image(1), image(2), image(3)] },
    });

    const outcome = result.outcomes[0];
    assert.equal(outcome?.state, "not-submitted");
    assert.equal(outcome?.state === "not-submitted" && outcome.reason, "before-submission");
    assert.equal(staging.calls(), 2);
    assert.equal(published.length, 0);
    assert.deepEqual(staging.cleaned, staging.staged);
    assert.doesNotMatch(JSON.stringify(result), /secret|bucket/);
  });

  test("revalidates the staged URL and lets the adapter reject it before dispatch", async () => {
    const published: PreparedPublishTarget[] = [];
    const staging = stagingFixture({ url: () => "http://127.0.0.1/file?sig=secret" });

    const social = createSocial({
      backend: publishAdapter({ declarations: [urlOnly], published }),
      mediaStaging: staging.provider,
    });

    const result = await social.posts.publish({
      targets: [{ account }],
      content: { media: [image(1)] },
    });

    assert.equal(result.outcomes[0]?.state, "not-submitted");
    assert.match(JSON.stringify(result), /media\.staging_url_invalid/);
    assert.doesNotMatch(JSON.stringify(result), /secret|127\.0\.0\.1/);
    assert.equal(published.length, 0);
    assert.equal(staging.cleaned.length, 1);
  });

  test("a rejected cleanup does not change the outcome", async () => {
    const social = createSocial({
      backend: publishAdapter({ declarations: [urlOnly] }),
      mediaStaging: {
        stageMedia: async () => ({
          url: "https://media.example.com/1",
          cleanup: async () => {
            throw new Error("storage offline");
          },
        }),
      },
    });

    const result = await social.posts.publish({
      targets: [{ account }],
      content: { media: [image(1)] },
    });

    assert.equal(result.outcomes[0]?.state, "published");
  });

  test("does not stage for unauthorized targets or idempotent replays, and keeps fingerprints", async () => {
    const staging = stagingFixture();

    const denied: AuthorizationPolicy = {
      authorizeTargets: async ({ accounts }) =>
        accounts.map((ref) => ({ account: ref, allowed: false })),
    };

    const blocked = createSocial({
      backend: publishAdapter({ declarations: [urlOnly] }),
      mediaStaging: staging.provider,
      authorization: denied,
    });

    await assert.rejects(
      blocked.posts.publish({ targets: [{ account }], content: { media: [image(1)] } }),
      (error) => error instanceof SocialError && error.code === "unauthorized",
    );
    assert.equal(staging.calls(), 0);

    const store = new MemoryIdempotencyStore();

    const social = createSocial({
      backend: publishAdapter({ declarations: [urlOnly] }),
      mediaStaging: staging.provider,
      idempotencyStore: store,
    });

    const request = {
      targets: [{ account }],
      content: { media: [image(1)] },
      idempotencyKey: "k1",
    };

    const first = await social.posts.publish(request);
    const replay = await social.posts.publish({ ...request, content: { media: [image(1)] } });

    assert.equal(staging.calls(), 1);
    assert.deepEqual(replay.outcomes, first.outcomes);
    assert.equal(replay.publication.publicationId, first.publication.publicationId);
  });

  test("does not stage for targets that accept local media", async () => {
    const published: PreparedPublishTarget[] = [];
    const staging = stagingFixture();

    const local: CapabilityDeclaration = {
      ...urlOnly,
      constraints: { mediaSources: ["https-url", "blob", "stream"] },
    };

    const social = createSocial({
      backend: defineAdapter({
        ...publishAdapter({ declarations: [local], published }),
        posts: {
          prepareTarget: () => [],
          async publishTarget(target) {
            published.push(target);

            return {
              state: "processing",
              targetIndex: target.targetIndex,
              account: target.account,
              observedAt: "t",
            };
          },
        },
      }),
      mediaStaging: staging.provider,
    });

    await social.posts.publish({ targets: [{ account }], content: { media: [image(1)] } });

    assert.equal(staging.calls(), 0);
    assert.equal(published[0]?.content.media?.[0]?.source.kind, "blob");
  });
});

function cursorOf(page: { readonly nextCursor?: string }): string {
  assert.ok(page.nextCursor !== undefined, "expected a next cursor");

  return page.nextCursor;
}

function readAdapter(
  failing: ReadonlySet<string> = new Set(),
  singlePage: ReadonlySet<string> = new Set(),
) {
  const pages = (key: string, cursor: string | undefined): Page<JsonObject> => {
    if (failing.has(key))
      throw new SocialError({ code: "rate_limited", operation: "fixture", message: "Slow down" });

    if (singlePage.has(key)) return { items: [{ id: `${key}-only` }] };

    return cursor === undefined
      ? { items: [{ id: `${key}-1`, message: "hello", from: { id: "u1" } }], nextCursor: "page-2" }
      : { items: [{ id: `${key}-2` }] };
  };

  return defineAdapter({
    id: "fixture",
    capabilities: {
      schemaVersion: 1,
      backend: "fixture",
      apiRevision: "fixture-v1",
      runtime: ["node"],
      capabilities: [
        { operation: "messages.read", platform: "*", availability: "available" },
        { operation: "comments.read", platform: "*", availability: "available" },
        { operation: "analytics.read", platform: "*", availability: "available" },
      ],
    },
    messages: {
      listConversations: async (ref, input) => pages(ref.accountId, input.cursor),
      listMessages: async () => ({ items: [] }),
      send: async () => ({}),
    },
    comments: {
      list: async (ref, input) => pages(ref.postId, input.cursor),
      reply: async (ref) => ref,
    },
    analytics: {
      getPostMetrics: async () => [
        { name: "like_count", value: 0, unit: "count", period: "lifetime", source: "fixture" },
        {
          name: "engagement_rate",
          value: 1,
          unit: "percentage",
          period: "lifetime",
          source: "fixture",
        },
      ],
    },
  });
}

describe("normalized read facades", () => {
  test("comments, conversations and metrics carry projected fields and keep provider data", async () => {
    const social = createSocial({ backend: readAdapter() });

    const post = platformPostRef({
      backend: "default",
      platform: "x",
      accountId: "a1",
      postId: "p1",
    });

    const comments = await social.comments.list(post);
    assert.equal(comments.items[0]?.id, "p1-1");
    assert.equal(comments.items[0]?.["message"], "hello");
    assert.deepEqual(comments.items[0]?.native["from"], { id: "u1" });

    const conversations = await social.messages.listConversations(account);
    assert.equal(conversations.items[0]?.id, "a1-1");

    const metrics = await social.analytics.getPostMetrics(post);
    assert.deepEqual(
      metrics.map((metric) => [metric.name, metric.canonicalName]),
      [
        ["like_count", "likes"],
        ["engagement_rate", undefined],
      ],
    );
  });
});

describe("inbox.list", () => {
  const second = connectedAccountRef({ backend: "default", platform: "x", accountId: "a2" });

  const post = platformPostRef({
    backend: "default",
    platform: "x",
    accountId: "a1",
    postId: "p1",
  });

  test("reads every source, keeps failures per source, and pages each source independently", async () => {
    const social = createSocial({ backend: readAdapter(new Set(["a2"])) });

    const first = await social.inbox.list({ accounts: [account, second], posts: [post], limit: 5 });

    assert.deepEqual(
      first.entries.map((entry) => [entry.kind, entry.sourceIndex, entry.record.id]),
      [
        ["conversation", 0, "a1-1"],
        ["comment", 2, "p1-1"],
      ],
    );
    assert.deepEqual(
      first.sources.map((source) => source.state),
      ["read", "failed", "read"],
    );
    assert.equal(first.sources[1]?.state === "failed" && first.sources[1].code, "rate_limited");
    assert.ok(first.nextCursor);

    const next = await social.inbox.list({
      accounts: [account, second],
      posts: [post],
      limit: 5,
      cursor: cursorOf(first),
    });

    assert.deepEqual(
      next.entries.map((entry) => entry.record.id),
      ["a1-2", "p1-2"],
    );
    assert.deepEqual(
      next.sources.map((source) => source.state),
      ["read", "failed", "read"],
    );
    assert.ok(next.nextCursor, "the failed source keeps its initial position");

    const recovered = createSocial({ backend: readAdapter() });

    const last = await recovered.inbox.list({
      accounts: [account, second],
      posts: [post],
      limit: 5,
      cursor: cursorOf(next),
    });

    assert.deepEqual(
      last.sources.map((source) => source.state),
      ["exhausted", "read", "exhausted"],
    );
    assert.deepEqual(
      last.entries.map((entry) => entry.record.id),
      ["a2-1"],
    );
  });

  test("omits nextCursor once every source is exhausted", async () => {
    const social = createSocial({ backend: readAdapter() });
    const input = { accounts: [account] };
    const first = await social.inbox.list(input);
    const second = await social.inbox.list({ ...input, cursor: cursorOf(first) });

    assert.equal(second.nextCursor, undefined);
    assert.equal(second.sources[0]?.state, "read");
  });

  test("binds cursors to sources, order, limit and tenant", async () => {
    const social = createSocial({ backend: readAdapter() });
    const first = await social.inbox.list({ accounts: [account, second] });

    for (const input of [
      { accounts: [second, account] },
      { accounts: [account, second], limit: 10 },
      { accounts: [account] },
    ])
      await assert.rejects(
        social.inbox.list({ ...input, cursor: cursorOf(first) }),
        (error) => error instanceof SocialError && error.code === "invalid_input",
      );

    await assert.rejects(
      social.inbox.list(
        { accounts: [account, second], cursor: cursorOf(first) },
        { authorization: { tenantId: "other" } },
      ),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );
  });

  test("reauthorizes every source on every call, including exhausted ones", async () => {
    let allowSecond = true;
    const checked: string[] = [];

    const policy: AuthorizationPolicy = {
      authorizeTargets: async ({ operation, accounts }) =>
        accounts.map((ref) => {
          checked.push(`${operation}:${ref.accountId}`);

          return { account: ref, allowed: ref.accountId !== "a2" || allowSecond };
        }),
    };

    const social = createSocial({
      backend: readAdapter(new Set(), new Set(["a1"])),
      authorization: policy,
    });

    const input = { accounts: [account, second] };

    const first = await social.inbox.list(input);
    allowSecond = false;
    checked.length = 0;
    const last = await social.inbox.list({ ...input, cursor: cursorOf(first) });

    assert.deepEqual(checked.sort(), ["messages.read:a1", "messages.read:a2"]);
    assert.deepEqual(
      last.sources.map((source) => source.state),
      ["exhausted", "failed"],
    );
    assert.equal(last.sources[1]?.state === "failed" && last.sources[1].code, "unauthorized");
  });

  test("rejects empty, duplicate and oversized source lists", async () => {
    const social = createSocial({ backend: readAdapter() });

    for (const input of [{}, { accounts: [account, account] }, { accounts: [account], limit: 101 }])
      await assert.rejects(
        social.inbox.list(input),
        (error) => error instanceof SocialError && error.code === "invalid_input",
      );
  });
});

describe("TikTok local photos through media staging", () => {
  const tiktokAccount = connectedAccountRef({
    backend: "default",
    platform: "tiktok",
    accountId: "creator1",
  });

  const photoOptions = {
    privacy: "SELF_ONLY" as const,
    consentGiven: true,
    disableComments: true,
    disableDuet: true,
    disableStitch: true,
    brandedContent: false,
    ownBrand: false,
    aiGenerated: false,
    draft: false,
    photoCoverIndex: 0,
    creatorInfo: {
      accountId: "creator1",
      backend: "default",
      username: "demo",
      nickname: "Demo",
      fetchedAt: "2026-09-19T00:00:00Z",
      privacyLevels: ["SELF_ONLY"],
      commentDisabled: false,
      duetDisabled: false,
      stitchDisabled: false,
      maxVideoDurationSeconds: 60,
    },
  };

  const request = {
    targets: [{ account: tiktokAccount, options: photoOptions }],
    content: { text: "photos", media: [image(1), image(2)] },
  };

  test("stages photos on the verified origin and keeps copies while TikTok pulls them", async () => {
    const photoUrls: unknown[] = [];

    const staging = stagingFixture({
      url: (call) => `https://media.example.test/staged/${call}.jpg`,
    });

    const adapter = tiktok({
      auth: { accessToken: "test", openId: "creator1" },
      verifiedMediaOrigins: ["https://media.example.test"],
      fetch: async (input, init) => {
        if (String(input).includes("creator_info"))
          return Response.json({
            data: {
              creator_username: "demo",
              creator_nickname: "Demo",
              privacy_level_options: ["SELF_ONLY"],
            },
            error: { code: "ok" },
          });

        photoUrls.push(JSON.parse(String(init?.body)).source_info);

        return Response.json({ data: { publish_id: "photo1" }, error: { code: "ok" } });
      },
    });

    const social = createSocial({
      backend: adapter,
      mediaStaging: { ...staging.provider, origin: "https://media.example.test" },
    });

    assert.deepEqual(social.posts.prepare(request).issues, []);

    const result = await social.posts.publish(request);
    const outcome = result.outcomes[0];

    assert.equal(outcome?.state, "accepted");
    assert.equal(outcome?.delivery?.deliveryId, "photo1");
    assert.deepEqual(photoUrls, [
      {
        source: "PULL_FROM_URL",
        photo_cover_index: 0,
        photo_images: [
          "https://media.example.test/staged/1.jpg",
          "https://media.example.test/staged/2.jpg",
        ],
      },
    ]);
    assert.equal(staging.staged.length, 2);
    assert.deepEqual(staging.cleaned, [], "TikTok fetches asynchronously, so copies stay");
  });

  test("an unverified staging origin fails preparation before anything is staged", async () => {
    const staging = stagingFixture();

    const social = createSocial({
      backend: tiktok({
        auth: { accessToken: "test", openId: "creator1" },
        verifiedMediaOrigins: ["https://media.example.test"],
        fetch: async () => assert.fail("no request expected"),
      }),
      mediaStaging: staging.provider,
    });

    const plan = social.posts.prepare(request);

    assert.equal(plan.ok, false);
    assert.ok(plan.issues.some((issue) => issue.code === "tiktok.origin"));
    await assert.rejects(social.posts.publish(request));
    assert.equal(staging.calls(), 0);
  });
});

describe("cancellation during dispatch", () => {
  test("an abort while the adapter runs keeps its returned delivery ID; queued targets cancel unsent", async () => {
    const controller = new AbortController();
    const entered: string[] = [];

    const second = connectedAccountRef({
      backend: "default",
      platform: "instagram",
      accountId: "a2",
    });

    const social = createSocial({
      concurrency: 1,
      backend: publishAdapter({
        declarations: [{ operation: "posts.publish", platform: "*", availability: "available" }],
        publish: (target) => {
          entered.push(target.account.accountId);
          controller.abort();

          return {
            state: "accepted",
            targetIndex: target.targetIndex,
            account: target.account,
            observedAt: "t",
            delivery: {
              kind: "delivery",
              version: 1,
              backend: "default",
              platform: target.account.platform,
              accountId: target.account.accountId,
              deliveryId: "init-1",
            },
          };
        },
      }),
    });

    const result = await social.posts.publish(
      { targets: [{ account }, { account: second }], content: { text: "hello" } },
      { signal: controller.signal },
    );

    assert.deepEqual(entered, ["a1"]);
    assert.equal(result.outcomes[0]?.state, "accepted");
    assert.equal(result.outcomes[0]?.delivery?.deliveryId, "init-1");
    assert.equal(result.outcomes[1]?.state, "cancelled");
    assert.equal(
      result.outcomes[1]?.state === "cancelled" && result.outcomes[1].reason,
      "before-submission",
    );
  });
});
