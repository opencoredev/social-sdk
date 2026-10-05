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
