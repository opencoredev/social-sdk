import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { postfast } from "../src/cloud/postfast.js";
import { postiz } from "../src/cloud/postiz.js";
import { postForMe } from "../src/cloud/post-for-me.js";
import { zernio } from "../src/cloud/zernio.js";
import { MemoryManagedMediaStore, type ManagedMediaStore } from "../src/cloud/media.js";
import { postForMeOutcome, zernioOutcome } from "../src/cloud/outcomes.js";
import { definedFields } from "../src/core/fields.js";
import { SocialError } from "../src/core/errors.js";
import type {
  AdapterOperationContext,
  MediaAttachment,
  PublishRequest,
} from "../src/core/types.js";

const clock = () => new Date("2026-10-05T12:00:00.000Z");

const at = "2026-10-06T12:00:00.000Z";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "audit",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
};

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "a1" });

const image: MediaAttachment = {
  kind: "image",
  mimeType: "image/jpeg",
  filename: "a.jpg",
  source: { kind: "blob", blob: new Blob(["image"]), fingerprint: "audit-image" },
};

const choices = {
  privacy: "SELF_ONLY" as const,
  consentGiven: true,
  disableComments: false,
  disableDuet: false,
  disableStitch: false,
  brandedContent: false,
  ownBrand: false,
  aiGenerated: false,
  draft: false,
};

it("PostFast rejects private direct TikTok photos before dispatch and allows explicit drafts", async () => {
  let calls = 0;

  const social = createSocial({
    backend: postfast({
      apiKey: "test",
      clock,
      fetch: async () => {
        calls++;

        return Response.json({});
      },
    }),
    clock,
  });

  const request: PublishRequest = {
    targets: [{ account: { ...account, platform: "tiktok" }, options: choices }],
    content: { media: [image] },
    schedule: { at },
  };

  assert.ok(
    social.posts
      .prepare(request)
      .issues.some((issue) => issue.code === "tiktok.privacy_unsupported"),
  );
  await assert.rejects(social.posts.publish(request), { code: "invalid_input" });
  assert.equal(calls, 0);
  assert.equal(
    social.posts.prepare({
      ...request,
      targets: [
        { account: { ...account, platform: "tiktok" }, options: { ...choices, draft: true } },
      ],
    }).ok,
    true,
  );
});

it("PostFast rejects a schedule beyond one year in prepare and direct adapter publish", async () => {
  let calls = 0;

  const adapter = postfast({
    apiKey: "test",
    clock,
    fetch: async () => {
      calls++;

      return Response.json({});
    },
  });

  const social = createSocial({ backend: adapter, clock });

  const request: PublishRequest = {
    targets: [{ account }],
    content: { text: "future" },
    schedule: { at: "2027-10-06T12:00:00.000Z" },
  };

  assert.equal(social.posts.prepare(request).ok, false);
  await assert.rejects(
    adapter.posts.publishTarget(
      {
        targetIndex: 0,
        targetKey: "audit",
        account,
        content: request.content,
        schedule: request.schedule,
      },
      context,
    ),
    { code: "invalid_input" },
  );
  assert.equal(calls, 0);
});

it("Zernio maps only a matched destination cancellation", () => {
  const ctx = { account, targetIndex: 0, observedAt: clock().toISOString() };
  assert.equal(
    zernioOutcome(
      { _id: "p1", platforms: [{ accountId: "a1", platform: "twitter", status: "cancelled" }] },
      ctx,
    ).state,
    "cancelled",
  );
  assert.equal(
    zernioOutcome({ _id: "p1", status: "cancelled", platforms: [] }, ctx).state,
    "unknown",
  );
});

it("Post for Me requires parent account ownership for pending outcomes", () => {
  const ctx = { account, targetIndex: 0, observedAt: clock().toISOString() };

  for (const status of ["scheduled", "processing"]) {
    for (const social_accounts of [
      undefined,
      ["other"],
      ["a1", "a1"],
      [{ id: "a1", platform: "instagram" }],
    ]) {
      const outcome = postForMeOutcome(
        { id: "p1", status, ...definedFields({ social_accounts }) },
        undefined,
        ctx,
      );

      assert.equal(outcome.state, "unknown");
      assert.equal(outcome.delivery?.deliveryId, "p1");
    }

    assert.equal(
      postForMeOutcome({ id: "p1", status, social_accounts: ["a1"] }, undefined, ctx).state,
      status,
    );
    assert.equal(
      postForMeOutcome(
        { id: "p1", status, social_accounts: [{ id: "a1", platform: "x" }] },
        undefined,
        ctx,
      ).state,
      status,
    );
  }
});

it("Post for Me maps Facebook likes separately from total reactions and overlapping views", async () => {
  const adapter = postForMe({
    apiKey: "test",
    fetch: async () =>
      Response.json({
        data: [
          {
            platform_post_id: "p1",
            social_account_id: "a1",
            metrics: {
              reactions_like: 2,
              reactions_total: 8,
              media_views: 20,
              video_views: 12,
              comments: 3,
            },
          },
        ],
      }),
  });

  const metrics = await adapter.analytics.getPostMetrics(
    { ...account, kind: "platform-post", platform: "facebook", postId: "p1" },
    context,
  );

  assert.deepEqual(
    metrics.map((metric) => [metric.name, metric.value]),
    [
      ["likes", 2],
      ["reactions", 8],
      ["comments", 3],
      ["views", 20],
    ],
  );

  const empty = postForMe({
    apiKey: "test",
    fetch: async () =>
      Response.json({
        data: [
          {
            platform_post_id: "p1",
            social_account_id: "a1",
            metrics: { reactions_total: 8, video_views: 12 },
          },
        ],
      }),
  });

  assert.deepEqual(
    (
      await empty.analytics.getPostMetrics(
        { ...account, kind: "platform-post", platform: "facebook", postId: "p1" },
        context,
      )
    ).map((metric) => [metric.name, metric.value]),
    [
      ["reactions", 8],
      ["views", 12],
    ],
  );
});

it("Post for Me feed preserves public media URLs and omits signed/private media", async () => {
  const adapter = postForMe({
    apiKey: "test",
    fetch: async () =>
      Response.json({
        data: [
          {
            social_account_id: "a1",
            platform_post_id: "p1",
            media: [
              "https://media.example.test/a.jpg",
              "https://media.example.test/private.jpg?token=secret",
              "http://localhost/a.jpg",
            ],
            access_token: "secret",
          },
        ],
      }),
  });

  const feed = await adapter.posts.list(account, {}, context);
  assert.deepEqual(feed.items[0]?.["media"], ["https://media.example.test/a.jpg"]);
  assert.doesNotMatch(JSON.stringify(feed), /secret|localhost/);
});

it("Zernio feed uses the selected destination publication timestamp", async () => {
  const adapter = zernio({
    apiKey: "test",
    fetch: async () =>
      Response.json({
        posts: [
          {
            _id: "p1",
            publishedAt: "parent",
            platforms: [
              { accountId: "a1", platform: "twitter", publishedAt: at, platformPostId: "n1" },
              { accountId: "other", platform: "twitter", publishedAt: "other" },
            ],
          },
        ],
      }),
  });

  assert.equal((await adapter.posts.list(account, {}, context)).items[0]?.["publishedAt"], at);
});

it("Zernio unconfirmed comment and message writes require reconciliation", async () => {
  const adapter = zernio({ apiKey: "test", fetch: async () => Response.json({ success: false }) });

  const check = (error: Error) =>
    error instanceof SocialError &&
    error.code === "ambiguous_outcome" &&
    error.retryDisposition.kind === "reconcile-first";

  await assert.rejects(
    adapter.comments.reply(
      { ...account, kind: "comment", postId: "p1", commentId: "c1" },
      { text: "reply" },
      context,
    ),
    check,
  );
  await assert.rejects(
    adapter.messages.send(
      { ...account, kind: "conversation", conversationId: "cv1" },
      { text: "message" },
      context,
    ),
    check,
  );
});

it("Postiz rejects unsupported publish MIME types, thumbnails, and returned upload paths", async () => {
  let calls = 0;

  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async () => {
      calls++;

      return Response.json({ id: "m1", path: "https://media.example.test/a.avif" });
    },
  });

  const social = createSocial({ backend: adapter, clock });

  for (const mimeType of ["image/avif", "image/bmp", "image/tiff"]) {
    assert.equal(
      social.posts.prepare({ targets: [{ account }], content: { media: [{ ...image, mimeType }] } })
        .ok,
      false,
    );
  }

  const withThumbnail: MediaAttachment = { ...image, thumbnail: image.source };
  assert.equal(
    social.posts.prepare({ targets: [{ account }], content: { media: [withThumbnail] } }).ok,
    false,
  );
  assert.equal(calls, 0);
  await assert.rejects(adapter.media.upload(image, account, context), { code: "invalid_input" });
  assert.equal(calls, 1);
});

it("Post for Me provider-uploaded refs expire after 24 hours and cannot be reused after submission", async () => {
  let time = clock().getTime();
  let creates = 0;
  const store = new MemoryManagedMediaStore();

  const social = createSocial({
    backend: postForMe({
      apiKey: "test",
      mediaStore: store,
      clock: () => new Date(time),
      uploadHostAllowed: (host) => host === "storage.example.test",
      fetch: async (input) => {
        const url = new URL(String(input));

        if (url.pathname.endsWith("create-upload-url"))
          return Response.json({
            upload_url: "https://storage.example.test/a",
            media_url: "https://media.example.test/a.jpg",
          });

        if (url.hostname === "storage.example.test") return new Response(null, { status: 200 });
        creates++;

        return Response.json({ id: "p1", status: "scheduled", social_accounts: ["a1"] });
      },
    }),
    clock: () => new Date(time),
  });

  const ref = await social.media.upload(image, account);
  assert.equal((await store.get(ref.mediaId))?.expiresAt, "2026-10-06T12:00:00.000Z");

  const request: PublishRequest = {
    targets: [{ account }],
    content: { media: [{ ...image, source: { kind: "media-ref", ref } }] },
  };

  assert.equal((await social.posts.publish(request)).outcomes[0]?.state, "scheduled");
  assert.equal((await social.posts.publish(request)).outcomes[0]?.state, "failed");
  assert.equal(creates, 1);
  const expired = await social.media.upload(image, account);
  time += 86400_000;
  assert.equal(
    (
      await social.posts.publish({
        ...request,
        content: { media: [{ ...image, source: { kind: "media-ref", ref: expired } }] },
      })
    ).outcomes[0]?.state,
    "failed",
  );
  assert.equal(creates, 1);

  const external = await social.media.upload(
    { ...image, source: { kind: "https-url", url: "https://media.example.test/owned.jpg" } },
    account,
  );

  assert.equal((await store.get(external.mediaId))?.expiresAt, undefined);
});

it("PostFast preserves all TikTok photo consent choices without a deprecated privacy control", async () => {
  const mediaStore = new MemoryManagedMediaStore();

  const tiktokAccount = connectedAccountRef({
    backend: "default",
    platform: "tiktok",
    accountId: "a1",
  });

  const ref = { ...tiktokAccount, kind: "media" as const, mediaId: "m1" };

  await mediaStore.put({
    ref,
    publicUrl: "https://media.example.test/a.jpg",
    providerKey: "photo-key",
    kind: "image",
    mimeType: "image/jpeg",
  });

  const adapter = postfast({
    apiKey: "test",
    mediaStore,
    clock,
    fetch: async (_input, init) => {
      if (init?.method === "POST") {
        assert.deepEqual(JSON.parse(String(init.body)).controls, {
          tiktokAllowComments: false,
          tiktokAllowDuet: true,
          tiktokAllowStitch: false,
          tiktokBrandOrganic: true,
          tiktokBrandContent: true,
          tiktokIsAigc: true,
          tiktokIsDraft: false,
        });

        return Response.json({ postIds: ["p1"] });
      }

      return Response.json({
        data: [
          {
            id: "p1",
            socialMediaId: "a1",
            status: "SCHEDULED",
            approvalStatus: "APPROVED",
            scheduledAt: at,
          },
        ],
      });
    },
  });

  const target = {
    targetIndex: 0,
    targetKey: "audit",
    account: tiktokAccount,
    content: { media: [{ ...image, source: { kind: "media-ref" as const, ref } }] },
    schedule: { at },
    options: {
      ...choices,
      privacy: "PUBLIC_TO_EVERYONE",
      disableComments: true,
      disableStitch: true,
      ownBrand: true,
      brandedContent: true,
      aiGenerated: true,
    },
  };

  assert.equal((await adapter.posts.publishTarget(target, context)).state, "scheduled");
  await assert.rejects(adapter.posts.publishTarget({ ...target, options: choices }, context), {
    code: "invalid_input",
  });
});

it("Zernio replays the target key when media is uploaded to a new URL", async () => {
  const keys: string[] = [];
  const urls: string[] = [];
  let uploads = 0;

  const social = createSocial({
    backend: zernio({
      apiKey: "test",
      uploadHostAllowed: (host) => host === "storage.example.test",
      fetch: async (input, init) => {
        const url = new URL(String(input));

        if (url.pathname.endsWith("presign")) {
          uploads++;

          return Response.json({
            uploadUrl: "https://storage.example.test/upload",
            publicUrl: `https://media.example.test/${uploads}.jpg`,
          });
        }

        if (url.hostname === "storage.example.test") return new Response(null, { status: 200 });
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("x-request-id"), null);
        keys.push(headers.get("Idempotency-Key") ?? "");
        urls.push(JSON.parse(String(init?.body)).mediaItems[0].url);

        return Response.json({
          post: {
            _id: "p1",
            platforms: [{ platform: "twitter", accountId: "a1", status: "pending" }],
          },
        });
      },
    }),
  });

  const request: PublishRequest = {
    targets: [{ account }],
    content: { media: [image] },
    idempotencyKey: "audit-replay",
  };

  await social.posts.publish(request);
  await social.posts.publish(request);
  assert.notEqual(urls[0], urls[1]);
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
});

it("Postiz preserves a scheduled create ID when the follow-up read is forbidden", async () => {
  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async (_input, init) =>
      init?.method === "POST"
        ? Response.json([{ postId: "p1", integration: "a1" }])
        : Response.json({}, { status: 403 }),
  });

  const outcome = await adapter.posts.publishTarget(
    {
      targetIndex: 0,
      targetKey: "audit",
      account,
      content: { text: "scheduled" },
      schedule: { at },
    },
    context,
  );

  assert.equal(outcome.state, "accepted");
  assert.equal(outcome.backendState, undefined);
  assert.equal(outcome.delivery?.deliveryId, `p1@${at}`);
});

class AsyncSharedMediaStore extends MemoryManagedMediaStore {
  override async claimSingleUse(mediaId: string, claimedAt: string) {
    await new Promise((resolve) => setTimeout(resolve, 5));

    return super.claimSingleUse(mediaId, claimedAt);
  }

  override async get(mediaId: string) {
    const snapshot = await super.get(mediaId);
    await new Promise((resolve) => setTimeout(resolve, 5));

    return snapshot;
  }
}

for (const asynchronous of [false, true]) {
  it(`Post for Me atomically claims shared uploaded refs through separate public clients (async=${asynchronous})`, async () => {
    const store = asynchronous ? new AsyncSharedMediaStore() : new MemoryManagedMediaStore();
    let creates = 0;

    const makeClient = () =>
      createSocial({
        backend: postForMe({
          apiKey: "test",
          mediaStore: store,
          clock,
          fetch: async () => {
            creates++;

            return Response.json({ id: "p1", status: "scheduled", social_accounts: ["a1"] });
          },
        }),
        clock,
      });

    const first = makeClient();
    const second = makeClient();
    const ref = { ...account, kind: "media" as const, mediaId: "shared-upload" };
    await store.put({
      ref,
      publicUrl: "https://media.example.test/a.jpg",
      kind: "image",
      mimeType: "image/jpeg",
      singleUse: true,
      expiresAt: "2026-10-06T12:00:00.000Z",
    });

    const request: PublishRequest = {
      targets: [{ account }],
      content: { media: [{ ...image, source: { kind: "media-ref", ref } }] },
    };

    const results = await Promise.all([
      first.posts.publish(request),
      second.posts.publish(request),
    ]);

    assert.deepEqual(results.map((result) => result.outcomes[0]?.state).sort(), [
      "failed",
      "scheduled",
    ]);
    assert.equal(creates, 1);
    assert.equal((await second.posts.publish(request)).outcomes[0]?.state, "failed");
    assert.equal(creates, 1);
    assert.equal((await store.get(ref.mediaId))?.expiresAt, clock().toISOString());
  });
}

it("Post for Me fails closed for single-use refs in legacy stores but preserves reusable URLs", async () => {
  const memory = new MemoryManagedMediaStore();

  const store: ManagedMediaStore = {
    put: (record) => memory.put(record),
    get: (mediaId) => memory.get(mediaId),
  };

  let creates = 0;

  const social = createSocial({
    backend: postForMe({
      apiKey: "test",
      mediaStore: store,
      clock,
      fetch: async () => {
        creates++;

        return Response.json({ id: "p1", status: "scheduled", social_accounts: ["a1"] });
      },
    }),
    clock,
  });

  const ref = { ...account, kind: "media" as const, mediaId: "legacy-upload" };
  await store.put({
    ref,
    publicUrl: "https://media.example.test/a.jpg",
    kind: "image",
    mimeType: "image/jpeg",
    singleUse: true,
  });

  const request: PublishRequest = {
    targets: [{ account }],
    content: { media: [{ ...image, source: { kind: "media-ref", ref } }] },
  };

  assert.equal((await social.posts.publish(request)).outcomes[0]?.state, "failed");
  assert.equal(creates, 0);

  const external = await social.media.upload(
    { ...image, source: { kind: "https-url", url: "https://media.example.test/owned.jpg" } },
    account,
  );

  const reusable = {
    ...request,
    content: { media: [{ ...image, source: { kind: "media-ref" as const, ref: external } }] },
  };

  assert.equal((await social.posts.publish(reusable)).outcomes[0]?.state, "scheduled");
  assert.equal((await social.posts.publish(reusable)).outcomes[0]?.state, "scheduled");
  assert.equal(creates, 2);
});

it("Post for Me keeps single-use claims consumed after dispatch failure and clock rollback", async () => {
  const store = new MemoryManagedMediaStore();
  let time = clock().getTime();
  let creates = 0;

  const social = createSocial({
    backend: postForMe({
      apiKey: "test",
      mediaStore: store,
      clock: () => new Date(time),
      fetch: async () => {
        creates++;

        return Response.json({}, { status: 400 });
      },
    }),
    clock: () => new Date(time),
  });

  const ref = { ...account, kind: "media" as const, mediaId: "failed-upload" };
  await store.put({
    ref,
    publicUrl: "https://media.example.test/a.jpg",
    kind: "image",
    mimeType: "image/jpeg",
    singleUse: true,
  });

  const request: PublishRequest = {
    targets: [{ account }],
    content: { media: [{ ...image, source: { kind: "media-ref", ref } }] },
  };

  assert.equal((await social.posts.publish(request)).outcomes[0]?.state, "failed");
  assert.equal(creates, 1);
  time -= 1000;
  assert.equal(await store.claimSingleUse(ref.mediaId, new Date(time).toISOString()), false);
  assert.equal((await social.posts.publish(request)).outcomes[0]?.state, "failed");
  assert.equal(creates, 1);
  assert.equal((await store.get(ref.mediaId))?.consumedAt, clock().toISOString());
});

it("Zernio duplicate recovery survives the public facade without replay or provider text", async () => {
  for (const existingPostId of ["post-123", "https://private.test/post", undefined]) {
    let creates = 0;

    const social = createSocial({
      backend: zernio({
        apiKey: "test",
        fetch: async (input, init) => {
          if (init?.method === "POST") {
            creates++;

            return Response.json(
              { details: { existingPostId, caption: "private caption" } },
              { status: 409 },
            );
          }

          assert.ok(String(input).endsWith("/v1/posts/post-123"));

          return Response.json({
            post: {
              _id: "post-123",
              platforms: [{ platform: "twitter", accountId: "a1", status: "pending" }],
            },
          });
        },
      }),
    });

    const outcome = (
      await social.posts.publish({
        targets: [{ account }],
        content: { text: "duplicate" },
        idempotencyKey: "duplicate",
      })
    ).outcomes[0];

    assert.equal(creates, 1);
    assert.ok(outcome);
    assert.ok(!JSON.stringify(outcome).includes("private"));

    if (existingPostId === "post-123") {
      assert.equal(outcome.state, "failed");
      assert.equal(outcome.state === "failed" ? outcome.code : undefined, "idempotency_conflict");
      assert.ok(outcome.delivery);
      assert.equal(outcome.delivery.deliveryId, "post-123");
      assert.equal((await social.posts.getDelivery(outcome.delivery)).state, "accepted");
      assert.equal(creates, 1);
    } else {
      assert.equal(outcome.delivery, undefined);
    }
  }
});

it("Post for Me claims a repeated upload once per submission and retains both attachments", async () => {
  const store = new MemoryManagedMediaStore();
  const ref = { ...account, kind: "media" as const, mediaId: "repeated" };
  await store.put({
    ref,
    publicUrl: "https://media.example.test/a.jpg",
    kind: "image",
    mimeType: "image/jpeg",
    singleUse: true,
    expiresAt: at,
  });
  let creates = 0;

  const social = createSocial({
    clock,
    backend: postForMe({
      apiKey: "test",
      clock,
      mediaStore: store,
      fetch: async (_input, init) => {
        creates++;
        assert.equal(JSON.parse(String(init?.body)).media.length, 2);

        return Response.json({ id: "p1", status: "scheduled", social_accounts: ["a1"] });
      },
    }),
  });

  const item = { ...image, source: { kind: "media-ref" as const, ref } };
  const request = { targets: [{ account }], content: { media: [item, item] } };
  assert.equal((await social.posts.publish(request)).outcomes[0]?.state, "scheduled");
  assert.equal(creates, 1);
  assert.equal((await store.get(ref.mediaId))?.consumedAt, clock().toISOString());
  assert.equal((await social.posts.publish(request)).outcomes[0]?.state, "failed");
  assert.equal(creates, 1);
});
