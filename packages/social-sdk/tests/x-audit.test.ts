import assert from "node:assert/strict";
import { it } from "node:test";
import { connectedAccountRef, createSocial, platformPostRef, SocialError } from "../src/index.js";
import type { AdapterOperationContext, Page, JsonObject } from "../src/index.js";
import { x } from "../src/platforms/x.js";

interface MediaStatusFixture {
  id: string;
  processing_info?: { state: string; check_after_secs: number };
}

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "1" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "audit",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

const auth = { userId: "1", accessToken: "fixture" };

it("rejects small user timeline, mentions and likes limits before dispatch", async () => {
  let calls = 0;

  const adapter = x({
    auth,
    fetch: async () => {
      calls++;

      return Response.json({ data: [] });
    },
  });

  assert.ok(adapter.native);

  for (const limit of [1, 4]) {
    for (const method of ["userPosts", "mentions", "likedPosts"] as const)
      await assert.rejects(adapter.native[method]({ account, userId: "1", limit, context }), {
        code: "invalid_input",
      });
    const social = createSocial({ backend: adapter });
    await assert.rejects(social.posts.list(account, { limit }), { code: "invalid_input" });
  }

  assert.equal(calls, 0);
});

it("requests only user fields for list members", async () => {
  const adapter = x({
    auth,
    fetch: async (input) => {
      const fields = new URL(String(input)).searchParams.get("user.fields")?.split(",") ?? [];
      assert.ok(fields.includes("username"));

      for (const field of ["private", "member_count", "follower_count"])
        assert.ok(!fields.includes(field));

      return Response.json({ data: [{ id: "2", username: "alice" }] });
    },
  });

  assert.ok(adapter.native);
  assert.equal(
    (await adapter.native.listMembers({ account, listId: "3", context })).items[0]?.["username"],
    "alice",
  );
});

it("maps simple image auth, throttling and size errors consistently", async () => {
  for (const [status, code] of [
    [401, "reconnect_required"],
    [429, "rate_limited"],
    [413, "media_error"],
  ] as const) {
    const adapter = x({
      auth,
      fetch: async () => new Response("", { status, headers: { "retry-after": "2" } }),
    });

    assert.ok(adapter.posts?.publishTarget);
    await assert.rejects(
      adapter.posts.publishTarget(
        {
          targetIndex: 0,
          targetKey: "x",
          account,
          content: {
            media: [
              {
                kind: "image",
                mimeType: "image/png",
                source: { kind: "blob", blob: new Blob(["fixture"]), fingerprint: "fixture" },
              },
            ],
          },
        },
        { ...context },
      ),
      (error: SocialError) => {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, code);

        if (status === 429)
          assert.deepEqual(error.retryDisposition, { kind: "after-delay", delayMs: 2000 });

        return true;
      },
    );
  }
});

it("accepts post video above the old DM ceiling and rejects above 16 GiB locally", () => {
  class SizedBlob extends Blob {
    override get size() {
      return 1024 * 1024 * 1024;
    }
  }

  class OversizedBlob extends Blob {
    override get size() {
      return 17_179_869_185;
    }
  }

  const social = createSocial({ backend: x({ auth }) });

  for (const [blob, expected] of [
    [new SizedBlob(), true],
    [new OversizedBlob(), false],
  ] as const)
    assert.equal(
      social.posts.prepare({
        targets: [{ account }],
        content: {
          media: [
            {
              kind: "video",
              mimeType: "video/mp4",
              source: { kind: "blob", blob, fingerprint: "fixture" },
            },
          ],
        },
      }).ok,
      expected,
    );
});

it("uploads the advertised 16 GiB ceiling without exceeding X segment index 9999", async () => {
  const maximumBytes = 17_179_869_184;

  for (const size of [maximumBytes - 1, maximumBytes]) {
    let uploadedBytes = 0;
    let appendCount = 0;
    let finalized = false;

    // Exercise every real APPEND request without allocating a 16 GiB video.
    // The fixture checks slice boundaries and substitutes a small multipart payload.
    class BoundaryBlob extends Blob {
      override get size() {
        return size;
      }

      override slice(start = 0, end = size, contentType = "") {
        assert.equal(start, uploadedBytes);
        assert.ok(end > start && end <= size);
        assert.ok(end - start <= 5_000_000);
        uploadedBytes += end - start;

        return new Blob(["fixture"], { type: contentType });
      }
    }

    const adapter = x({
      auth,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;

        if (path.endsWith("/initialize")) {
          const body: unknown = JSON.parse(String(init?.body));
          assert.deepEqual(body, {
            media_category: "tweet_video",
            media_type: "video/mp4",
            total_bytes: size,
          });

          return Response.json({ data: { id: "boundary" } });
        }

        if (path.endsWith("/append")) {
          assert.ok(init?.body instanceof FormData);
          const index = Number(init.body.get("segment_index"));
          assert.equal(index, appendCount);
          assert.ok(index <= 9999, `APPEND index ${index} exceeds X's maximum`);
          appendCount++;

          return new Response(null, { status: 204 });
        }

        assert.equal(path, "/2/media/upload/boundary/finalize");
        assert.equal(uploadedBytes, size);
        finalized = true;

        return Response.json({ data: { id: "boundary" } });
      },
    });

    const blob = new BoundaryBlob();
    assert.equal(
      createSocial({ backend: adapter }).posts.prepare({
        targets: [{ account }],
        content: {
          media: [
            {
              kind: "video",
              mimeType: "video/mp4",
              source: { kind: "blob", blob, fingerprint: "boundary" },
            },
          ],
        },
      }).ok,
      true,
    );
    assert.ok(adapter.native);
    assert.equal(
      (
        await adapter.native.uploadVideo({
          account,
          video: blob,
          context: { ...context, retryBudget: { maxAttempts: 1, maxElapsedMs: 60_000 } },
        })
      ).mediaId,
      "boundary",
    );
    assert.equal(appendCount, 4096);
    assert.equal(finalized, true);
  }
});

it("decodes both metric generations with new names taking precedence", async () => {
  const social = createSocial({
    backend: x({
      auth,
      fetch: async (input) =>
        Response.json({
          data: String(input).includes("/tweets/")
            ? { id: "3", author_id: "1", public_metrics: { repost_count: 7, retweet_count: 5 } }
            : { id: "1", public_metrics: { post_count: 9, tweet_count: 6 } },
        }),
    }),
  });

  const post = platformPostRef({ backend: "default", platform: "x", accountId: "1", postId: "3" });
  assert.equal(
    (await social.analytics.getPostMetrics(post)).find((metric) => metric.name === "reposts")
      ?.value,
    7,
  );
  assert.equal(
    (await social.analytics.getAccountMetrics(account)).find(
      (metric) => metric.name === "tweet_count",
    )?.value,
    9,
  );
});

it("allows graph pages up to 1000 without widening unrelated endpoints", async () => {
  const adapter = x({
    auth,
    fetch: async (input) => {
      assert.equal(new URL(String(input)).searchParams.get("max_results"), "1000");

      return Response.json({ data: [] });
    },
  });

  assert.ok(adapter.native);

  for (const method of ["followers", "following", "mutedUsers", "blockedUsers"] as const)
    await adapter.native[method]({ account, userId: "1", limit: 1000, context });
  await assert.rejects(adapter.native.likingUsers({ account, postId: "3", limit: 101, context }), {
    code: "invalid_input",
  });
});

it("requires user credentials for private reads and all native mutations", async () => {
  let calls = 0;

  const adapter = x({
    auth: { userId: "1" },
    appBearerToken: "app",
    fetch: async () => {
      calls++;

      return Response.json({ data: {} });
    },
  });

  assert.ok(adapter.native);
  const native = adapter.native;

  const operations = [
    () => native.mutedUsers({ account, context }),
    () => native.blockedUsers({ account, context }),
    () => native.pinnedLists({ account, context }),
    () => native.follow({ account, userId: "2", context }),
    () => native.unfollow({ account, userId: "2", context }),
    () => native.repost({ account, postId: "3", context }),
    () => native.undoRepost({ account, postId: "3", context }),
    () => native.bookmarks({ account, context }),
    () => native.bookmark({ account, postId: "3", context }),
    () => native.removeBookmark({ account, postId: "3", context }),
    () => native.createList({ account, name: "list", context }),
    () => native.updateList({ account, listId: "3", name: "list", context }),
    () => native.deleteList({ account, listId: "3", context }),
    () => native.addListMember({ account, listId: "3", userId: "2", context }),
    () => native.removeListMember({ account, listId: "3", userId: "2", context }),
    () => native.followList({ account, listId: "3", context }),
    () => native.unfollowList({ account, listId: "3", context }),
  ];

  for (const operation of operations)
    await assert.rejects(operation(), { code: "missing_permission" });
  assert.equal(calls, 0);
});

it("uses app authentication for public list lookup", async () => {
  const adapter = x({
    auth: { userId: "1" },
    appBearerToken: "app",
    fetch: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer app");

      return Response.json({ data: { id: "3" } });
    },
  });

  assert.ok(adapter.native);
  await adapter.native.getList({ account, listId: "3", context });
});

it("retains DM sender fields and validated expansion metadata", async () => {
  const adapter = x({
    auth,
    fetch: async (input) => {
      const fields = new URL(String(input)).searchParams.get("dm_event.fields")?.split(",") ?? [];
      assert.ok(fields.includes("sender_id"));
      assert.ok(fields.includes("participant_ids"));

      return Response.json({
        data: [{ id: "3", sender_id: "2" }],
        includes: { users: [{ id: "2", username: "alice" }] },
      });
    },
  });

  assert.ok(adapter.native);
  assert.deepEqual((await adapter.native.listDirectMessages({ account, context })).metadata, {
    includes: { users: [{ id: "2", username: "alice" }] },
  });
});

it("accepts one media-only conversation message and validates attachments locally", async () => {
  let calls = 0;

  const adapter = x({
    auth,
    fetch: async (_input, init) => {
      calls++;
      assert.deepEqual(JSON.parse(String(init?.body)), { attachments: [{ media_id: "123" }] });

      return Response.json({ data: { dm_event_id: "3" } });
    },
  });

  assert.ok(adapter.native);
  await adapter.native.sendConversationMessage({
    account,
    conversationId: "3",
    text: "",
    attachments: [{ media_id: "123" }],
    context,
  });

  for (const attachments of [
    [],
    [{}],
    [{ media_id: "" }],
    [{ media_id: "abc" }],
    [{ media_id: "1" }, { media_id: "2" }],
  ])
    await assert.rejects(
      adapter.native.sendConversationMessage({
        account,
        conversationId: "3",
        text: "",
        attachments,
        context,
      }),
      { code: "invalid_input" },
    );
  assert.equal(calls, 1);
});

it("preserves timeline expansion joins and requests user and media fields", async () => {
  const includes = {
    users: [{ id: "2", username: "alice" }],
    tweets: [{ id: "4", text: "original" }],
    media: [{ media_key: "m", type: "photo" }],
  };

  const adapter = x({
    auth,
    fetch: async (input) => {
      const query = new URL(String(input)).searchParams;
      assert.ok(query.get("user.fields")?.includes("username"));
      assert.ok(query.get("media.fields")?.includes("media_key"));
      assert.ok(query.get("expansions")?.includes("attachments.media_keys"));

      return Response.json({
        data: [{ id: "3", author_id: "2", referenced_tweets: [{ type: "retweeted", id: "4" }] }],
        includes,
      });
    },
  });

  assert.ok(adapter.native);

  for (const method of [
    "userPosts",
    "homeTimeline",
    "mentions",
    "likedPosts",
    "listPosts",
  ] as const) {
    const page: Page<JsonObject> = await adapter.native[method]({
      account,
      userId: "1",
      listId: "3",
      context,
    });

    assert.deepEqual(page.metadata, { includes });
  }
});

it("rejects pinned-list pagination instead of silently ignoring inputs", async () => {
  let calls = 0;

  const adapter = x({
    auth,
    fetch: async () => {
      calls++;

      return Response.json({ data: [] });
    },
  });

  assert.ok(adapter.native);
  await assert.rejects(adapter.native.pinnedLists({ account, limit: 20, context }), {
    code: "invalid_input",
  });
  await assert.rejects(adapter.native.pinnedLists({ account, cursor: "next", context }), {
    code: "invalid_input",
  });
  assert.equal(calls, 0);
});

it("preserves initialized media ID and reconcile-first at polling ceiling or deadline", async () => {
  for (const checkAfterSecs of [0, 2]) {
    const adapter = x({
      auth,
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;

        if (path.endsWith("/append")) return new Response(null, { status: 204 });

        const data: MediaStatusFixture = { id: "123" };

        if (!path.endsWith("/initialize"))
          data.processing_info = { state: "pending", check_after_secs: checkAfterSecs };

        return Response.json({ data });
      },
    });

    assert.ok(adapter.native);
    await assert.rejects(
      adapter.native.uploadVideo({
        account,
        video: new Blob(["fixture"]),
        context: { ...context },
      }),
      (error: SocialError) => {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, "timeout");
        assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });
        assert.deepEqual(error.details, { mediaId: "123" });

        return true;
      },
    );
  }
});

it("retains reply references from both wire generations", async () => {
  for (const field of ["referenced_posts", "referenced_tweets"]) {
    const social = createSocial({
      backend: x({
        auth,
        fetch: async () =>
          Response.json({
            data: [
              {
                id: "4",
                conversation_id: "3",
                author_id: "2",
                text: "reply",
                [field]: [{ type: "replied_to", id: "3" }],
              },
            ],
          }),
      }),
    });

    const post = platformPostRef({
      backend: "default",
      platform: "x",
      accountId: "1",
      postId: "3",
    });

    const page = await social.comments.list(post, { limit: 10 });
    assert.deepEqual(page.items[0]?.["referenced_tweets"], [{ type: "replied_to", id: "3" }]);
  }
});

it("keeps single-item home, list and liking-user pages valid", async () => {
  const adapter = x({ auth, fetch: async () => Response.json({ data: [] }) });
  assert.ok(adapter.native);
  await adapter.native.homeTimeline({ account, limit: 1, context });
  await adapter.native.listPosts({ account, listId: "3", limit: 1, context });
  await adapter.native.likingUsers({ account, postId: "3", limit: 1, context });
  await adapter.native.userPosts({ account, userId: "1", limit: 5, context });
});

it("requires user context for normalized post and reply writes before dispatch", async () => {
  let calls = 0;

  const adapter = x({
    auth: { userId: "1" },
    appBearerToken: "app",
    fetch: async () => {
      calls++;

      return Response.json({ data: { id: "3" } });
    },
  });

  assert.ok(adapter.posts?.publishTarget);
  assert.ok(adapter.comments?.reply);
  await assert.rejects(
    adapter.posts.publishTarget(
      { targetIndex: 0, targetKey: "x", account, content: { text: "fixture" } },
      context,
    ),
    { code: "missing_permission" },
  );
  await assert.rejects(
    adapter.comments.reply(
      {
        kind: "comment",
        version: 1,
        backend: "default",
        platform: "x",
        accountId: "1",
        postId: "3",
        commentId: "3",
      },
      { text: "fixture" },
      context,
    ),
    { code: "missing_permission" },
  );
  assert.equal(calls, 0);
});

it("preserves terminal X usage caps during media STATUS polling", async () => {
  let statusCalls = 0;

  const adapter = x({
    auth,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;

      if (path.endsWith("/append")) return new Response(null, { status: 204 });

      if (path.endsWith("/initialize")) return Response.json({ data: { id: "123" } });

      if (path.endsWith("/finalize"))
        return Response.json({
          data: { id: "123", processing_info: { state: "pending", check_after_secs: 0 } },
        });
      statusCalls++;

      return Response.json({ type: "https://api.x.com/2/problems/usage-capped" }, { status: 429 });
    },
  });

  assert.ok(adapter.native);
  await assert.rejects(
    adapter.native.uploadVideo({ account, video: new Blob(["fixture"]), context }),
    (error: Error) => {
      assert.ok(error instanceof SocialError);
      assert.equal(error.code, "billing_required");
      assert.equal(error.upstreamStatus, 429);
      assert.equal(error.upstreamCode, "usage-capped");
      assert.deepEqual(error.retryDisposition, { kind: "never" });
      assert.deepEqual(error.details, { mediaId: "123" });

      return true;
    },
  );
  assert.equal(statusCalls, 1);
});

it("retains the finalized media ID when STATUS transport or response parsing fails", async () => {
  for (const failure of ["http", "network", "malformed"]) {
    let statusCalls = 0;

    const adapter = x({
      auth,
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;

        if (path.endsWith("/append")) return new Response(null, { status: 204 });

        if (path.endsWith("/initialize")) return Response.json({ data: { id: "123" } });

        if (path.endsWith("/finalize"))
          return Response.json({
            data: { id: "456", processing_info: { state: "pending", check_after_secs: 0 } },
          });
        statusCalls++;

        if (failure === "network") throw new Error("offline transport failure");

        return failure === "http"
          ? Response.json({}, { status: 503 })
          : Response.json({ data: null });
      },
    });

    assert.ok(adapter.native);
    await assert.rejects(
      adapter.native.uploadVideo({ account, video: new Blob(["fixture"]), context }),
      (error: Error) => {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, "media_error");
        assert.deepEqual(error.details, { mediaId: "456" });
        assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });

        if (failure === "http") assert.equal(error.upstreamStatus, 503);

        return true;
      },
    );
    assert.equal(statusCalls, 1);
  }
});

it("keeps provider-confirmed processing failure terminal", async () => {
  const adapter = x({
    auth,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;

      if (path.endsWith("/append")) return new Response(null, { status: 204 });

      if (path.endsWith("/initialize")) return Response.json({ data: { id: "123" } });

      return Response.json({
        data: {
          id: "123",
          processing_info: {
            state: path.endsWith("/finalize") ? "pending" : "failed",
            check_after_secs: 0,
          },
        },
      });
    },
  });

  assert.ok(adapter.native);
  await assert.rejects(
    adapter.native.uploadVideo({ account, video: new Blob(["fixture"]), context }),
    (error: Error) => {
      assert.ok(error instanceof SocialError);
      assert.equal(error.code, "media_error");
      assert.deepEqual(error.retryDisposition, { kind: "never" });

      return true;
    },
  );
});

it("retains initialized upload IDs through APPEND and FINALIZE interruptions and normalized outcomes", async () => {
  for (const interruptedPhase of ["append", "finalize", "status"]) {
    const adapter = x({
      auth,
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;

        if (path.endsWith("/initialize")) return Response.json({ data: { id: "123" } });

        if (
          path.endsWith(`/${interruptedPhase}`) ||
          (interruptedPhase === "status" && path.endsWith("/upload"))
        )
          throw new Error("Offline interrupted upload");

        if (path.endsWith("/append")) return new Response(null, { status: 204 });

        return Response.json({
          data: { id: "123", processing_info: { state: "pending", check_after_secs: 0 } },
        });
      },
    });

    assert.ok(adapter.native);
    await assert.rejects(
      adapter.native.uploadVideo({ account, video: new Blob(["fixture"]), context }),
      (error: Error) => {
        assert.ok(error instanceof SocialError);
        assert.deepEqual(error.details, { mediaId: "123" });
        assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });

        return true;
      },
    );

    const result = await createSocial({ backend: adapter }).posts.publish({
      targets: [{ account }],
      content: {
        text: "fixture",
        media: [
          {
            kind: "video",
            mimeType: "video/mp4",
            source: { kind: "blob", blob: new Blob(["fixture"]), fingerprint: "fixture" },
          },
        ],
      },
    });

    const outcome = result.outcomes[0];
    assert.ok(outcome?.state === "failed");
    assert.equal(outcome.mediaId, "123");
    assert.deepEqual(outcome.retryDisposition, { kind: "reconcile-first" });
  }
});

it("retains upload IDs in normalized unknown outcomes at the processing deadline", async () => {
  const social = createSocial({
    backend: x({
      auth,
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;

        if (path.endsWith("/append")) return new Response(null, { status: 204 });

        if (path.endsWith("/initialize")) return Response.json({ data: { id: "123" } });

        return Response.json({
          data: { id: "123", processing_info: { state: "pending", check_after_secs: 0 } },
        });
      },
    }),
  });

  const result = await social.posts.publish({
    targets: [{ account }],
    content: {
      text: "fixture",
      media: [
        {
          kind: "video",
          mimeType: "video/mp4",
          source: { kind: "blob", blob: new Blob(["fixture"]), fingerprint: "fixture" },
        },
      ],
    },
  });

  const outcome = result.outcomes[0];
  assert.ok(outcome?.state === "unknown");
  assert.equal(outcome.mediaId, "123");
});
