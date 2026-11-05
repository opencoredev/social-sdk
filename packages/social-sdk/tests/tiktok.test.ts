import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { definedFields } from "../src/core/fields.js";
import { SocialError } from "../src/core/errors.js";
import { tiktok } from "../src/platforms/tiktok.js";
import type {
  AdapterOperationContext,
  JsonValue,
  PublishRequest,
  TikTokPublishOptions,
} from "../src/core/types.js";

const account = connectedAccountRef({
  backend: "default",
  platform: "tiktok",
  accountId: "creator1",
});

const creator = {
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
};

const options: TikTokPublishOptions = {
  privacy: "SELF_ONLY",
  consentGiven: true,
  disableComments: true,
  disableDuet: true,
  disableStitch: true,
  brandedContent: false,
  ownBrand: false,
  aiGenerated: false,
  draft: false,
};

const request: PublishRequest = {
  targets: [{ account, options: { ...options, creatorInfo: creator } }],
  content: {
    text: "caption",
    media: [
      {
        kind: "video",
        mimeType: "video/mp4",
        durationSeconds: 30,
        source: { kind: "https-url", url: "https://media.example.test/video.mp4" },
      },
    ],
  },
};

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const response = (data: JsonValue) => Response.json({ data, error: { code: "ok" } });

it("TikTok validates consent and verified origins locally before any transfer", () => {
  let calls = 0;

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async () => {
      calls++;
      throw new Error("must not run");
    },
  });

  const social = createSocial({ backend: adapter });
  assert.ok(social.posts.prepare(request).ok);
  assert.equal(
    social.posts.prepare({
      ...request,
      targets: [
        {
          account,
          options: { privacy: "SELF_ONLY", consentGiven: false, aiGenerated: false, draft: false },
        },
      ],
    }).ok,
    false,
  );
  assert.equal(
    social.posts.prepare({
      ...request,
      content: {
        media: [
          {
            kind: "video",
            source: { kind: "https-url", url: "https://unverified.example.test/v.mp4" },
          },
        ],
      },
    }).ok,
    false,
  );
  assert.equal(calls, 0);
});

it("TikTok queries current creator restrictions and preserves explicit privacy/disclosures", async () => {
  const calls: string[] = [];

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);

      if (path.includes("creator_info"))
        return response({
          creator_username: "demo",
          creator_nickname: "Demo",
          privacy_level_options: ["SELF_ONLY"],
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: false,
          max_video_post_duration_sec: 60,
        });
      const body = JSON.parse(String(init?.body));
      assert.equal(body.post_info.privacy_level, "SELF_ONLY");
      assert.equal(body.post_info.brand_content_toggle, false);
      assert.equal(body.post_info.disable_comment, true);
      assert.equal(body.source_info.source, "PULL_FROM_URL");

      return response({ publish_id: "publish1" });
    },
  });

  const result = await createSocial({ backend: adapter }).posts.publish(request);
  assert.equal(result.outcomes[0]?.state, "accepted");
  assert.equal(result.outcomes[0]?.delivery?.deliveryId, "publish1");
  assert.deepEqual(calls, ["/v2/post/publish/creator_info/query/", "/v2/post/publish/video/init/"]);
});

it("TikTok exposes the documented Direct Post preflight and Display video query fields", async () => {
  const calls: { path: string; body?: JsonValue; fields?: string }[] = [];

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        ...definedFields({
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        }),
        ...definedFields({ fields: url.searchParams.get("fields") ?? undefined }),
      });

      return response({
        videos: [
          {
            id: "video1",
            embed_html: "<blockquote>video</blockquote>",
            embed_link: "https://www.tiktok.com/player/v1/video1",
            is_aigc: false,
          },
        ],
      });
    },
  });

  const declaration = adapter.capabilities.capabilities.find(
    (entry) => entry.operation === "posts.publish.preflight",
  );

  assert.deepEqual(declaration, {
    platform: "tiktok",
    operation: "posts.publish.preflight",
    availability: "available",
    requiredScopes: ["video.publish"],
    notes:
      "Direct Post refreshes creator_info/query immediately before initialization. Inbox drafts do not require this preflight.",
  });

  assert.ok(adapter.native);

  const result = await adapter.native.queryVideos({
    account,
    videoIds: ["video1"],
    context,
  });

  assert.deepEqual(result["videos"], [
    {
      id: "video1",
      embed_html: "<blockquote>video</blockquote>",
      embed_link: "https://www.tiktok.com/player/v1/video1",
      is_aigc: false,
    },
  ]);
  assert.equal(calls[0]?.path, "/v2/video/query/");
  assert.deepEqual(calls[0]?.body, { filters: { video_ids: ["video1"] } });
  assert.ok(calls[0]?.fields?.includes("embed_html"));
  assert.ok(calls[0]?.fields?.includes("embed_link"));
  assert.ok(calls[0]?.fields?.includes("is_aigc"));
});

it("TikTok bounds Display video queries to the documented filter size", async () => {
  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async () => {
      throw new Error("must not run");
    },
  });

  assert.ok(adapter.native);
  await assert.rejects(
    adapter.native.queryVideos({
      account,
      videoIds: Array.from({ length: 21 }, (_, index) => `video${index}`),
      context,
    }),
    (error: Error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("TikTok refuses changed creator privacy before initializing a post", async () => {
  let calls = 0;

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async () => {
      calls++;

      return response({
        creator_username: "demo",
        creator_nickname: "Demo",
        privacy_level_options: ["PUBLIC_TO_EVERYONE"],
      });
    },
  });

  const result = await createSocial({ backend: adapter }).posts.publish(request);
  assert.equal(result.outcomes[0]?.state, "failed");
  assert.equal(calls, 1);
});

it("TikTok reports malformed creator snapshots during preparation", () => {
  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async () => {
      throw new Error("must not run");
    },
  });

  const result = createSocial({ backend: adapter }).posts.prepare({
    ...request,
    targets: [{ account, options: { ...options, creatorInfo: JSON.parse("[]") } }],
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "tiktok.creator_info"));
});

it("TikTok bounds native Display list pagination before dispatch", async () => {
  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async () => {
      throw new Error("must not run");
    },
  });

  assert.ok(adapter.native);

  for (const input of [
    { cursor: "-1", maxCount: 1 },
    { cursor: "1.5", maxCount: 1 },
    { cursor: "0", maxCount: 21 },
  ])
    await assert.rejects(
      adapter.native.listVideos({ account, ...input, context }),
      (error: Error) => error instanceof SocialError && error.code === "invalid_input",
    );
});

it("TikTok normalized video reads request and preserve the shared Display fields", async () => {
  const requests: { path: string; fields: string | null }[] = [];

  const video = {
    id: "video1",
    embed_html: "<blockquote>video</blockquote>",
    embed_link: "https://www.tiktok.com/player/v1/video1",
    is_aigc: false,
  };

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname, fields: url.searchParams.get("fields") });

      return response({ videos: [video] });
    },
  });

  const posts = adapter.posts;
  assert.ok(posts?.get);
  assert.ok(posts?.list);

  const post = await posts.get(
    {
      kind: "platform-post",
      version: 1,
      backend: "default",
      platform: "tiktok",
      accountId: "creator1",
      postId: "video1",
    },
    context,
  );

  const page = await posts.list(account, { limit: 1 }, context);

  assert.deepEqual(post, video);
  assert.deepEqual(page.items, [video]);
  assert.equal(requests.length, 2);

  for (const request of requests) {
    assert.equal(
      request.fields,
      "id,create_time,cover_image_url,share_url,title,video_description,duration,height,width,like_count,comment_count,share_count,view_count,embed_html,embed_link,is_aigc",
    );
  }
});

it("TikTok draft inbox remains accepted and large native IDs retain their exact decimal digits", async () => {
  let state = "SEND_TO_USER_INBOX";

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async () =>
      new Response(
        `{"error":{"code":"ok"},"data":{"status":"${state}","publicaly_available_post_id":[9007199254740993]}}`,
      ),
  });

  const ref = {
    kind: "delivery" as const,
    version: 1 as const,
    backend: "default",
    platform: "tiktok",
    accountId: "creator1",
    deliveryId: "p1",
  };

  assert.ok(adapter.posts?.getDelivery);
  assert.equal((await adapter.posts.getDelivery(ref, context)).state, "accepted");
  state = "PUBLISH_COMPLETE";
  const result = await adapter.posts.getDelivery(ref, context);
  assert.equal(result.state, "published");

  if (result.state === "published") assert.equal(result.post.postId, "9007199254740993");
});

it("TikTok SELF_ONLY completion is published even without a public post id", async () => {
  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async () => response({ status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] }),
  });

  assert.ok(adapter.posts?.getDelivery);

  const result = await adapter.posts.getDelivery(
    {
      kind: "delivery",
      version: 1,
      backend: "default",
      platform: "tiktok",
      accountId: "creator1",
      deliveryId: "private1",
    },
    context,
  );

  assert.equal(result.state, "accepted");
});

it("TikTok draft initialization skips creator info and uses the inbox endpoint", async () => {
  const calls: string[] = [];

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      assert.equal(path, "/v2/post/publish/inbox/video/init/");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.source_info.source, "PULL_FROM_URL");
      assert.equal("post_info" in body, false);

      return response({ publish_id: "draft1" });
    },
  });

  const draftRequest = {
    ...request,
    targets: [
      {
        account,
        options: { ...options, draft: true },
      },
    ],
  };

  const result = await createSocial({ backend: adapter }).posts.publish(draftRequest);
  assert.equal(result.outcomes[0]?.state, "accepted");
  assert.deepEqual(calls, ["/v2/post/publish/inbox/video/init/"]);
});

it("TikTok post metrics are available through the social facade", async () => {
  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async () =>
      response({
        videos: [{ id: "post1", like_count: 4, comment_count: 2, share_count: 1, view_count: 20 }],
      }),
  });

  const metrics = await createSocial({ backend: adapter }).analytics.getPostMetrics({
    kind: "platform-post",
    version: 1,
    backend: "default",
    platform: "tiktok",
    accountId: "creator1",
    postId: "post1",
  });

  assert.equal(metrics.length, 4);
  assert.equal(metrics.find((metric) => metric.name === "view_count")?.value, 20);
});

it("TikTok photo publishing keeps cover order and disables unrequested added music", async () => {
  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async (input, init) => {
      if (String(input).includes("creator_info"))
        return response({
          creator_username: "demo",
          creator_nickname: "Demo",
          privacy_level_options: ["SELF_ONLY"],
        });
      const body = JSON.parse(String(init?.body));
      assert.equal(body.media_type, "PHOTO");
      assert.equal(body.source_info.photo_cover_index, 1);
      assert.equal(body.post_info.auto_add_music, false);
      assert.equal(body.is_aigc, false);
      assert.equal("is_aigc" in body.post_info, false);
      assert.equal("disable_duet" in body.post_info, false);
      assert.equal("disable_stitch" in body.post_info, false);
      assert.deepEqual(body.source_info.photo_images, [
        "https://media.example.test/1.jpg",
        "https://media.example.test/2.jpg",
      ]);

      return response({ publish_id: "photo1" });
    },
  });

  const base = request.targets[0];
  assert.ok(base);

  const result = await createSocial({ backend: adapter }).posts.publish({
    targets: [{ ...base, options: { ...base.options, photoCoverIndex: 1 } }],
    content: {
      text: "photos",
      media: [1, 2].map((index) => ({
        kind: "image",
        mimeType: "image/jpeg",
        source: { kind: "https-url", url: `https://media.example.test/${index}.jpg` },
      })),
    },
  });

  assert.equal(result.outcomes[0]?.state, "accepted");
});

it("TikTok rejects Zernio-only photo options instead of silently ignoring them", () => {
  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
  });

  const social = createSocial({ backend: adapter });
  const directBase: TikTokPublishOptions = { ...options, creatorInfo: creator };

  for (const option of [{ description: "photo description" }, { mediaType: "photo" as const }]) {
    const preparation = social.posts.prepare({
      targets: [{ account, options: { ...directBase, ...option } }],
      content: {
        text: "photos",
        media: [
          {
            kind: "image" as const,
            mimeType: "image/jpeg",
            source: { kind: "https-url" as const, url: "https://media.example.test/photo.jpg" },
          },
        ],
      },
    });

    assert.equal(preparation.ok, false);
  }
});

for (const transport of ["custom", "default"]) {
  for (const retryAfter of [undefined, "2", "999999999"]) {
    it(`TikTok ${transport} fetch preserves HTTP 429 with a bounded delay (${retryAfter})`, async () => {
      let calls = 0;

      const fetch: typeof globalThis.fetch = async () => {
        calls++;

        return Response.json(
          { error: { code: "rate_limit_exceeded" } },
          { status: 429, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } },
        );
      };

      const originalFetch = globalThis.fetch;

      if (transport === "default") globalThis.fetch = fetch;

      try {
        const adapter = tiktok({
          auth: { accessToken: "test", openId: "creator1" },
          verifiedMediaOrigins: [],
          ...definedFields({ fetch: transport === "custom" ? fetch : undefined }),
        });

        assert.ok(adapter.native);
        await assert.rejects(
          adapter.native.creatorInfo(account, {
            ...context,
            retryBudget: { maxAttempts: 5, maxElapsedMs: 30000 },
          }),
          (error: Error) => {
            assert.ok(error instanceof SocialError);
            assert.equal(error.code, "rate_limited");
            assert.equal(error.upstreamStatus, 429);
            assert.equal(error.upstreamCode, "rate_limit_exceeded");
            assert.deepEqual(error.retryDisposition, {
              kind: "after-delay",
              delayMs: retryAfter === "2" ? 2000 : 60000,
            });

            return true;
          },
        );
        assert.equal(calls, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
}

it("TikTok HTTP 429 ignores missing, malformed and non-string provider codes", async () => {
  for (const body of ["not JSON", "{}", '{"error":{"code":42}}', '{"error":{"code":{}}}']) {
    let calls = 0;

    const adapter = tiktok({
      auth: { accessToken: "test", openId: "creator1" },
      verifiedMediaOrigins: [],
      fetch: async () => {
        calls++;

        return new Response(body, { status: 429, headers: { "retry-after": "2" } });
      },
    });

    assert.ok(adapter.native);
    await assert.rejects(adapter.native.creatorInfo(account, context), (error: Error) => {
      assert.ok(error instanceof SocialError);
      assert.equal(error.code, "rate_limited");
      assert.equal(error.upstreamStatus, 429);
      assert.equal(error.upstreamCode, undefined);
      assert.deepEqual(error.retryDisposition, { kind: "after-delay", delayMs: 2000 });

      return true;
    });
    assert.equal(calls, 1);
  }
});

it("TikTok maps structured rate_limit_exceeded without HTTP 429 and never retries init", async () => {
  let calls = 0;

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async () => {
      calls++;

      return Response.json({ error: { code: "rate_limit_exceeded" } });
    },
  });

  assert.ok(adapter.native);
  await assert.rejects(
    adapter.native.uploadDraft({ account, video: {}, context }),
    (error: Error) => {
      assert.ok(error instanceof SocialError);
      assert.equal(error.code, "rate_limited");
      assert.equal(error.upstreamCode, "rate_limit_exceeded");
      assert.deepEqual(error.retryDisposition, { kind: "after-delay", delayMs: 60000 });

      return true;
    },
  );
  assert.equal(calls, 1);
});

it("TikTok rejects branded SELF_ONLY Direct Posts during preparation and before init", async () => {
  let calls = 0;

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async () => {
      calls++;

      return response({
        creator_username: "demo",
        creator_nickname: "Demo",
        privacy_level_options: ["SELF_ONLY"],
      });
    },
  });

  const social = createSocial({ backend: adapter });

  const preparation = social.posts.prepare({
    ...request,
    targets: [{ account, options: { ...options, creatorInfo: creator, brandedContent: true } }],
  });

  assert.equal(preparation.ok, false);
  assert.ok(preparation.issues.some((issue) => issue.code === "tiktok.branded_privacy"));
  assert.equal(calls, 0);
  const target = preparation.targets[0];
  assert.ok(target);
  assert.ok(adapter.posts?.publishTarget);
  await assert.rejects(adapter.posts.publishTarget(target, context), (error: Error) => {
    assert.ok(error instanceof SocialError);
    assert.equal(error.code, "invalid_input");
    assert.match(error.message, /branded content/i);

    return true;
  });
  assert.ok(calls <= 1); // No Direct Post initialization or media transfer.
});

it("TikTok inbox drafts do not apply branded Direct Post visibility rules", async () => {
  const calls: string[] = [];

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async (input) => {
      calls.push(new URL(String(input)).pathname);

      return response({ publish_id: "draft1" });
    },
  });

  const social = createSocial({ backend: adapter });

  const draftRequest = {
    ...request,
    targets: [{ account, options: { ...options, draft: true, brandedContent: true } }],
  };

  assert.equal(social.posts.prepare(draftRequest).ok, true);
  const result = await social.posts.publish(draftRequest);
  assert.equal(result.outcomes[0]?.state, "accepted");
  assert.deepEqual(calls, ["/v2/post/publish/inbox/video/init/"]);
});

it("TikTok refuses refreshed photo comment restrictions before init", async () => {
  const calls: string[] = [];

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);

      if (path.includes("creator_info"))
        return response({
          creator_username: "demo",
          creator_nickname: "Demo",
          privacy_level_options: ["SELF_ONLY"],
          comment_disabled: true,
          duet_disabled: true,
          stitch_disabled: true,
        });

      return response({ publish_id: "photo1" });
    },
  });

  const social = createSocial({ backend: adapter });

  const photoRequest: PublishRequest = {
    targets: [
      {
        account,
        options: {
          ...options,
          creatorInfo: creator,
          photoCoverIndex: 0,
          disableComments: false,
          disableDuet: false,
          disableStitch: false,
        },
      },
    ],
    content: {
      media: [
        {
          kind: "image",
          source: {
            kind: "https-url",
            url: "https://media.example.test/photo.jpg",
          },
        },
      ],
    },
  };

  const rejected = await social.posts.publish(photoRequest);
  assert.equal(rejected.outcomes[0]?.state, "failed");
  assert.deepEqual(calls, ["/v2/post/publish/creator_info/query/"]);

  calls.length = 0;

  const accepted = await social.posts.publish({
    ...photoRequest,
    targets: [
      {
        account,
        options: {
          ...options,
          creatorInfo: creator,
          photoCoverIndex: 0,
          disableComments: true,
          disableDuet: false,
          disableStitch: false,
        },
      },
    ],
  });

  assert.equal(accepted.outcomes[0]?.state, "accepted");
  assert.deepEqual(calls, [
    "/v2/post/publish/creator_info/query/",
    "/v2/post/publish/content/init/",
  ]);
});

for (const transport of ["custom", "default"]) {
  it(`TikTok ${transport} fetch maps HTTP 400 scope_permission_missed`, async () => {
    const fetch: typeof globalThis.fetch = async () =>
      Response.json(
        {
          data: {},
          error: {
            code: "scope_permission_missed",
            message: "The user did not authorize a field scope.",
          },
        },
        { status: 400 },
      );

    const originalFetch = globalThis.fetch;

    if (transport === "default") globalThis.fetch = fetch;

    try {
      const adapter = tiktok({
        auth: { accessToken: "test", openId: "creator1" },
        verifiedMediaOrigins: [],
        ...definedFields({ fetch: transport === "custom" ? fetch : undefined }),
      });

      const social = createSocial({ backend: adapter });
      await assert.rejects(social.analytics.getAccountMetrics(account), (error: Error) => {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, "missing_permission");
        assert.equal(error.upstreamCode, "scope_permission_missed");

        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

it("TikTok missing requested video metrics fail while missing individual counts stay absent", async () => {
  let videos: JsonValue = [{ id: "another-video", view_count: 8 }];

  const social = createSocial({
    backend: tiktok({
      auth: { accessToken: "test", openId: "creator1" },
      verifiedMediaOrigins: [],
      fetch: async () => response({ videos }),
    }),
  });

  const post = {
    kind: "platform-post" as const,
    version: 1 as const,
    backend: "default",
    platform: "tiktok",
    accountId: "creator1",
    postId: "post1",
  };

  for (const missing of [videos, []]) {
    videos = missing;
    await assert.rejects(social.analytics.getPostMetrics(post), (error: Error) => {
      assert.ok(error instanceof SocialError);
      assert.equal(error.code, "upstream_failure");
      assert.equal(error.operation, "analytics.read");
      assert.equal(error.message, "TikTok video was not found for this authorization.");

      return true;
    });
  }

  videos = [{ id: "post1", view_count: 0 }];
  const metrics = await social.analytics.getPostMetrics(post);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]?.name, "view_count");
  assert.equal(metrics[0]?.value, 0);
});

for (const transport of ["custom", "default"]) {
  for (const bodyKind of ["declared", "chunked", "stalled"]) {
    it(`TikTok ${transport} fetch bounds and cancels ${bodyKind} 429 evidence`, async () => {
      let calls = 0;
      let pulledBytes = 0;
      let cancelled = false;
      const chunk = new Uint8Array(64 * 1024).fill(32);

      const fetch: typeof globalThis.fetch = async () => {
        calls++;

        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (bodyKind === "stalled") return new Promise<void>(() => {});
                pulledBytes += chunk.byteLength;
                controller.enqueue(chunk);

                if (pulledBytes >= 4 * 1024 * 1024) controller.close();
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          {
            status: 429,
            headers: {
              "retry-after": "2",
              ...definedFields({
                "content-length": bodyKind === "declared" ? String(4 * 1024 * 1024) : undefined,
              }),
            },
          },
        );
      };

      const originalFetch = globalThis.fetch;

      if (transport === "default") globalThis.fetch = fetch;

      try {
        const adapter = tiktok({
          auth: { accessToken: "test", openId: "creator1" },
          verifiedMediaOrigins: [],
          ...definedFields({ fetch: transport === "custom" ? fetch : undefined }),
        });

        assert.ok(adapter.native);
        await assert.rejects(
          adapter.native.uploadDraft({
            account,
            video: {},
            context: {
              ...context,
              retryBudget: { maxAttempts: 5, maxElapsedMs: bodyKind === "stalled" ? 20 : 1000 },
            },
          }),
          (error: Error) => {
            assert.ok(error instanceof SocialError);
            assert.equal(error.code, "rate_limited");
            assert.equal(error.upstreamStatus, 429);
            assert.deepEqual(error.retryDisposition, { kind: "after-delay", delayMs: 2000 });
            assert.equal(error.upstreamCode, undefined);

            return true;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(calls, 1);
        assert.equal(cancelled, true);
        assert.ok(pulledBytes <= 2 * 1024 * 1024 + chunk.byteLength);

        if (bodyKind === "declared") assert.equal(pulledBytes, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
}

for (const transport of ["custom", "default"]) {
  for (const retryAfter of ["2", "999999", "invalid"]) {
    it(`TikTok ${transport} fetch honors structured rate-limit Retry-After (${retryAfter})`, async () => {
      let calls = 0;

      const fetch: typeof globalThis.fetch = async () => {
        calls++;

        return Response.json(
          { error: { code: "rate_limit_exceeded" } },
          { headers: { "retry-after": retryAfter } },
        );
      };

      const originalFetch = globalThis.fetch;

      if (transport === "default") globalThis.fetch = fetch;

      try {
        const adapter = tiktok({
          auth: { accessToken: "test", openId: "creator1" },
          verifiedMediaOrigins: [],
          ...definedFields({ fetch: transport === "custom" ? fetch : undefined }),
        });

        assert.ok(adapter.native);
        await assert.rejects(
          adapter.native.uploadDraft({ account, video: {}, context }),
          (error: Error) => {
            assert.ok(error instanceof SocialError);
            assert.equal(error.code, "rate_limited");
            assert.equal(error.upstreamCode, "rate_limit_exceeded");
            assert.deepEqual(error.retryDisposition, {
              kind: "after-delay",
              delayMs: retryAfter === "2" ? 2000 : 60000,
            });

            return true;
          },
        );
        assert.equal(calls, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
}

it("TikTok read retries do not retain a previous attempt's rate-limit rejection", async () => {
  let calls = 0;

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async () => {
      calls++;

      if (calls === 1)
        return Response.json(
          { error: { code: "rate_limit_exceeded" } },
          { status: 429, headers: { "retry-after": "0" } },
        );
      throw new TypeError("Offline network failure");
    },
  });

  assert.ok(adapter.accounts?.get);
  await assert.rejects(
    adapter.accounts.get(account, {
      ...context,
      retryBudget: { maxAttempts: 2, maxElapsedMs: 1000 },
    }),
    (error: Error) => {
      assert.ok(error instanceof SocialError);
      assert.equal(error.code, "upstream_failure");
      assert.equal(error.upstreamStatus, undefined);
      assert.equal(error.upstreamCode, undefined);

      return true;
    },
  );
  assert.equal(calls, 2);
});

for (const transport of ["custom", "default"]) {
  it(`TikTok ${transport} fetch preserves cancellation during a rate-limit read retry wait`, async () => {
    let calls = 0;

    const controller = new AbortController();

    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      setTimeout(() => controller.abort(), 20);

      return Response.json(
        { error: { code: "rate_limit_exceeded" } },
        { status: 429, headers: { "retry-after": "0.2" } },
      );
    };

    const originalFetch = globalThis.fetch;

    if (transport === "default") globalThis.fetch = fetch;

    try {
      const adapter = tiktok({
        auth: { accessToken: "test", openId: "creator1" },
        verifiedMediaOrigins: [],
        ...definedFields({ fetch: transport === "custom" ? fetch : undefined }),
      });

      assert.ok(adapter.accounts?.get);
      await assert.rejects(
        adapter.accounts.get(account, {
          ...context,
          signal: controller.signal,
          retryBudget: { maxAttempts: 2, maxElapsedMs: 1000 },
        }),
        (error: Error) => {
          assert.ok(error instanceof SocialError);
          assert.equal(error.code, "cancelled");
          assert.deepEqual(error.retryDisposition, { kind: "never" });

          return true;
        },
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

const photoContent = (count: number, byteSize?: number) => ({
  text: "photos",
  media: Array.from({ length: count }, (_, index) => ({
    kind: "image" as const,
    mimeType: "image/jpeg",
    ...definedFields({ byteSize }),
    source: { kind: "https-url" as const, url: `https://media.example.test/${index}.jpg` },
  })),
});

const creatorResponse = (extra: Record<string, JsonValue> = {}) =>
  response({
    creator_username: "demo",
    creator_nickname: "Demo",
    privacy_level_options: ["SELF_ONLY"],
    comment_disabled: false,
    duet_disabled: false,
    stitch_disabled: false,
    max_video_post_duration_sec: 60,
    ...extra,
  });

it("TikTok sends video_cover_timestamp_ms in video Direct Post post_info", async () => {
  const bodies: JsonValue[] = [];

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async (input, init) => {
      if (String(input).includes("creator_info")) return creatorResponse();
      bodies.push(JSON.parse(String(init?.body)));

      return response({ publish_id: "cover1" });
    },
  });

  const social = createSocial({ backend: adapter });
  const base = request.targets[0];
  assert.ok(base);

  const result = await social.posts.publish({
    ...request,
    targets: [{ ...base, options: { ...base.options, videoCoverTimestampMs: 1500 } }],
  });

  assert.equal(result.outcomes[0]?.state, "accepted");
  assert.deepEqual(bodies, [
    {
      post_info: {
        title: "caption",
        privacy_level: "SELF_ONLY",
        disable_comment: true,
        brand_content_toggle: false,
        brand_organic_toggle: false,
        disable_duet: true,
        disable_stitch: true,
        is_aigc: false,
        video_cover_timestamp_ms: 1500,
      },
      source_info: { source: "PULL_FROM_URL", video_url: "https://media.example.test/video.mp4" },
    },
  ]);

  // The video lasts 30 seconds, so a cover frame at 31 s, a fraction, a negative value,
  // a photo post and an inbox draft are all rejected before any request.
  const rejected: readonly TikTokPublishOptions[] = [
    { ...options, creatorInfo: creator, videoCoverTimestampMs: 31_000 },
    { ...options, creatorInfo: creator, videoCoverTimestampMs: 1.5 },
    { ...options, creatorInfo: creator, videoCoverTimestampMs: -1 },
    { ...options, draft: true, videoCoverTimestampMs: 1000 },
  ];

  for (const rejectedOptions of rejected) {
    const preparation = social.posts.prepare({
      ...request,
      targets: [{ account, options: rejectedOptions }],
    });

    assert.equal(preparation.ok, false);
  }

  assert.equal(
    social.posts.prepare({
      targets: [
        {
          account,
          options: {
            ...options,
            creatorInfo: creator,
            photoCoverIndex: 0,
            videoCoverTimestampMs: 0,
          },
        },
      ],
      content: photoContent(1),
    }).ok,
    false,
  );
});

it("TikTok sends auto_add_music on photo Direct Post only [feature:tiktok.publish.photo.auto_add_music]", async () => {
  const bodies: { post_info: Record<string, JsonValue>; post_mode: string }[] = [];

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async (input, init) => {
      if (String(input).includes("creator_info")) return creatorResponse();
      bodies.push(JSON.parse(String(init?.body)));

      return response({ publish_id: "music1" });
    },
  });

  const social = createSocial({ backend: adapter });

  const result = await social.posts.publish({
    targets: [
      {
        account,
        options: { ...options, creatorInfo: creator, photoCoverIndex: 0, autoAddMusic: true },
      },
    ],
    content: photoContent(2),
  });

  assert.equal(result.outcomes[0]?.state, "accepted");
  assert.equal(bodies[0]?.post_mode, "DIRECT_POST");
  assert.equal(bodies[0]?.post_info["auto_add_music"], true);

  // Video posts and inbox drafts have no auto_add_music field, so the option is refused.
  assert.equal(
    social.posts.prepare({
      ...request,
      targets: [{ account, options: { ...options, creatorInfo: creator, autoAddMusic: true } }],
    }).ok,
    false,
  );
  assert.equal(
    social.posts.prepare({
      targets: [
        { account, options: { ...options, draft: true, photoCoverIndex: 0, autoAddMusic: true } },
      ],
      content: photoContent(1),
    }).ok,
    false,
  );
});

it("TikTok photo inbox drafts send MEDIA_UPLOAD without Direct Post fields [feature:tiktok.publish.photo.media_upload]", async () => {
  const calls: { path: string; body: JsonValue }[] = [];

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async (input, init) => {
      calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });

      return response({ publish_id: "inbox-photo1" });
    },
  });

  const result = await createSocial({ backend: adapter }).posts.publish({
    targets: [
      {
        account,
        options: { ...options, draft: true, photoCoverIndex: 1, title: "Draft title" },
      },
    ],
    content: photoContent(2),
  });

  assert.equal(result.outcomes[0]?.state, "accepted");
  // Inbox drafts skip creator_info and send only the text fields TikTok accepts for MEDIA_UPLOAD.
  assert.deepEqual(calls, [
    {
      path: "/v2/post/publish/content/init/",
      body: {
        post_info: { title: "Draft title", description: "photos" },
        source_info: {
          source: "PULL_FROM_URL",
          photo_cover_index: 1,
          photo_images: ["https://media.example.test/0.jpg", "https://media.example.test/1.jpg"],
        },
        post_mode: "MEDIA_UPLOAD",
        media_type: "PHOTO",
        is_aigc: false,
      },
    },
  ]);
});

it("TikTok creator info returns creator_avatar_url as avatarUrl", async () => {
  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    clock: () => new Date("2026-11-04T00:00:00Z"),
    fetch: async () =>
      creatorResponse({ creator_avatar_url: "https://p16.tiktokcdn.example/avatar.jpeg" }),
  });

  assert.ok(adapter.native);
  const info = await adapter.native.creatorInfo(account, context);
  assert.equal(info["avatarUrl"], "https://p16.tiktokcdn.example/avatar.jpeg");

  const withoutAvatar = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async () => creatorResponse(),
  });

  assert.ok(withoutAvatar.native);
  assert.equal((await withoutAvatar.native.creatorInfo(account, context))["avatarUrl"], null);
});

it("TikTok refuses photos over 20 MB before any request", () => {
  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
  });

  const social = createSocial({ backend: adapter });
  const target = { account, options: { ...options, creatorInfo: creator, photoCoverIndex: 0 } };

  assert.equal(
    social.posts.prepare({ targets: [target], content: photoContent(1, 20 * 1024 * 1024) }).ok,
    true,
  );

  const tooLarge = social.posts.prepare({
    targets: [target],
    content: photoContent(1, 20 * 1024 * 1024 + 1),
  });

  assert.equal(tooLarge.ok, false);

  if (!tooLarge.ok) assert.ok(tooLarge.issues.some((issue) => issue.code === "tiktok.photo_size"));
});

it("TikTok keeps every post ID when one publish_id produced several posts", async () => {
  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async () =>
      new Response(
        '{"error":{"code":"ok"},"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7290000000000000001,7290000000000000002]}}',
      ),
  });

  assert.ok(adapter.posts?.getDelivery);

  const result = await adapter.posts.getDelivery(
    {
      kind: "delivery",
      version: 1,
      backend: "default",
      platform: "tiktok",
      accountId: "creator1",
      deliveryId: "inbox1",
    },
    context,
  );

  assert.equal(result.state, "accepted");

  if (result.state === "accepted")
    assert.deepEqual(result.postIds, ["7290000000000000001", "7290000000000000002"]);
});

it("TikTok getProfile reads user.info.basic fields including avatar_url and union_id", async () => {
  const urls: URL[] = [];

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async (input) => {
      urls.push(new URL(String(input)));

      return response({
        user: {
          open_id: "creator1",
          union_id: "union-1",
          avatar_url: "https://p16.tiktokcdn.example/avatar.jpeg",
          avatar_url_100: "https://p16.tiktokcdn.example/avatar100.jpeg",
          avatar_large_url: "https://p16.tiktokcdn.example/avatar-large.jpeg",
          display_name: "Demo",
        },
      });
    },
  });

  const profile = await createSocial({ backend: adapter }).graph.getProfile(account, {});

  assert.equal(urls[0]?.pathname, "/v2/user/info/");
  assert.equal(
    urls[0]?.searchParams.get("fields"),
    "open_id,union_id,avatar_url,avatar_url_100,avatar_large_url,display_name",
  );
  assert.deepEqual(profile, {
    ref: {
      kind: "profile",
      version: 1,
      backend: "default",
      platform: "tiktok",
      accountId: "creator1",
      profileId: "creator1",
    },
    displayName: "Demo",
    avatarUrl: "https://p16.tiktokcdn.example/avatar.jpeg",
    native: {
      open_id: "creator1",
      union_id: "union-1",
      avatar_url: "https://p16.tiktokcdn.example/avatar.jpeg",
      avatar_url_100: "https://p16.tiktokcdn.example/avatar100.jpeg",
      avatar_large_url: "https://p16.tiktokcdn.example/avatar-large.jpeg",
      display_name: "Demo",
    },
  });

  // The Display API reads only the authorized creator.
  await assert.rejects(
    createSocial({ backend: adapter }).graph.getProfile(account, { handle: "someone" }),
    (error: Error) => error instanceof SocialError && error.code === "unauthorized",
  );
  assert.equal(urls.length, 1);
});

it("TikTok getProfile adds user.info.profile fields (bio_description, profile_deep_link) when granted", async () => {
  let fields: string | null = null;

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    userInfoProfile: true,
    fetch: async (input) => {
      fields = new URL(String(input)).searchParams.get("fields");

      return response({
        user: {
          open_id: "creator1",
          display_name: "Demo",
          username: "demo",
          bio_description: "Short bio",
          profile_deep_link: "https://www.tiktok.com/@demo",
          is_verified: false,
        },
      });
    },
  });

  const profile = await createSocial({ backend: adapter }).graph.getProfile(account, {
    profileId: "creator1",
  });

  assert.equal(
    fields,
    "open_id,union_id,avatar_url,avatar_url_100,avatar_large_url,display_name,bio_description,profile_deep_link,is_verified,username",
  );
  assert.equal(profile.handle, "demo");
  assert.equal(profile.bio, "Short bio");
  assert.equal(profile.native?.["profile_deep_link"], "https://www.tiktok.com/@demo");
  assert.equal(profile.native?.["is_verified"], false);
});

it("TikTok native userInfo requests only documented fields and checks the creator", async () => {
  const requested: (string | null)[] = [];
  let openId = "creator1";

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async (input) => {
      requested.push(new URL(String(input)).searchParams.get("fields"));

      return response({ user: { open_id: openId, union_id: "union-1", follower_count: 5 } });
    },
  });

  assert.ok(adapter.native);
  assert.deepEqual(
    await adapter.native.userInfo({ account, fields: ["union_id", "follower_count"], context }),
    { open_id: "creator1", union_id: "union-1", follower_count: 5 },
  );
  assert.deepEqual(requested, ["open_id,union_id,follower_count"]);

  openId = "someone-else";
  await assert.rejects(
    adapter.native.userInfo({ account, fields: ["union_id"], context }),
    (error: Error) => error instanceof SocialError && error.code === "unauthorized",
  );
});

it("TikTok Data Portability add, check and cancel send the documented portability requests", async () => {
  const calls: { path: string; fields: string | null; body: JsonValue }[] = [];

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        fields: url.searchParams.get("fields"),
        body: JSON.parse(String(init?.body)),
      });

      if (url.pathname === "/v2/user/data/add/") return response({ request_id: 123451234512345 });

      if (url.pathname === "/v2/user/data/check/")
        return response({
          request_id: 123451234512345,
          status: "downloading",
          apply_time: 1703186989,
          collect_time: 1703187862,
          data_format: "json",
          category_selection_list: ["profile", "direct_message"],
        });

      return Response.json({ error: { code: "ok", message: "", log_id: "log" } });
    },
  });

  assert.ok(adapter.native);

  assert.deepEqual(
    await adapter.native.addDataRequest({
      account,
      dataFormat: "json",
      categories: ["profile", "direct_message"],
      context,
    }),
    { requestId: "123451234512345" },
  );
  assert.deepEqual(
    await adapter.native.checkDataRequest({ account, requestId: "123451234512345", context }),
    {
      requestId: "123451234512345",
      state: "downloading",
      providerStatus: "downloading",
      categories: ["profile", "direct_message"],
      appliedAt: "2023-12-21T19:29:49.000Z",
      collectionStartedAt: "2023-12-21T19:44:22.000Z",
      dataFormat: "json",
    },
  );
  await adapter.native.cancelDataRequest({ account, requestId: "123451234512345", context });

  assert.deepEqual(calls, [
    {
      path: "/v2/user/data/add/",
      fields: "request_id",
      body: { data_format: "json", category_selection_list: ["profile", "direct_message"] },
    },
    {
      path: "/v2/user/data/check/",
      fields: "request_id,status,apply_time,collect_time,data_format,category_selection_list",
      body: { request_id: 123451234512345 },
    },
    { path: "/v2/user/data/cancel/", fields: null, body: { request_id: 123451234512345 } },
  ]);

  // Request IDs that cannot round-trip through a JSON number are refused before dispatch.
  await assert.rejects(
    adapter.native.cancelDataRequest({ account, requestId: "9007199254740993", context }),
    (error: Error) => error instanceof SocialError && error.code === "invalid_input",
  );
  assert.equal(calls.length, 3);
});

it("TikTok Data Portability download streams the zip and maps the portability error envelope", async () => {
  const archive = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  let mode: "zip" | "error" = "zip";
  const seen: { url: string; init: RequestInit | undefined }[] = [];

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async (input, init) => {
      seen.push({ url: String(input), init });

      return mode === "zip"
        ? new Response(archive, { headers: { "content-type": "application/zip" } })
        : Response.json(
            {
              data: {},
              error: { code: "invalid_params", message: "Incorrect `request_id`.", log_id: "l" },
            },
            { status: 400 },
          );
    },
  });

  assert.ok(adapter.native);

  const stream = await adapter.native.downloadDataRequest({
    account,
    requestId: "123451234512345",
    context,
  });

  assert.deepEqual(new Uint8Array(await new Response(stream).arrayBuffer()), archive);
  assert.equal(seen[0]?.url, "https://open.tiktokapis.com/v2/user/data/download/");
  assert.equal(seen[0]?.init?.method, "POST");
  assert.equal(seen[0]?.init?.redirect, "manual");
  assert.equal(new Headers(seen[0]?.init?.headers).get("authorization"), "Bearer test");
  assert.equal(seen[0]?.init?.body, '{"request_id":123451234512345}');

  mode = "error";
  await assert.rejects(
    adapter.native.downloadDataRequest({ account, requestId: "1", context }),
    (error: Error) =>
      error instanceof SocialError &&
      error.code === "upstream_failure" &&
      error.upstreamCode === "invalid_params",
  );
});
