import { strict as assert } from "node:assert";
import { it } from "node:test";
import { object, string } from "../src/transport/validation.js";
import {
  instagram,
  type InstagramWorkflow,
  type InstagramWorkflowStore,
} from "../src/platforms/instagram.js";
import {
  SocialError,
  connectedAccountRef,
  createSocial,
  type MediaAttachment,
  type JsonObject,
} from "../src/core/index.js";

const account = connectedAccountRef({
  backend: "default",
  platform: "instagram",
  accountId: "ig1",
});

const context = {
  backendInstance: "default",
  correlationId: "audit",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10000 },
};

it("reads both hashtag edges with user_id and only permitted fields", async () => {
  const urls: URL[] = [];

  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1", flavor: "facebook-login" },
    fetch: async (input) => {
      urls.push(new URL(String(input)));

      return Response.json({ data: [{ id: "media", username: "must-omit" }] });
    },
  });

  assert.ok(adapter.native);

  for (const kind of ["recent", "top"] as const) {
    const result = await adapter.native.hashtagMedia({ account, hashtagId: "tag", kind, context });
    assert.deepEqual(result.items, [{ id: "media" }]);
  }

  for (const url of urls) {
    assert.equal(url.searchParams.get("user_id"), "ig1");
    assert.equal(url.searchParams.get("fields")?.includes("username"), false);
  }
});

it("continues native Reels and Stories once and preserves ambiguous writes", async () => {
  for (const kind of ["reel", "story"] as const) {
    for (const ambiguous of [false, true]) {
      let ready = false;
      let publishes = 0;

      const adapter = instagram({
        auth: { accessToken: "token", accountId: "ig1" },
        fetch: async (input) => {
          const url = new URL(String(input));

          if (url.pathname.endsWith("/media")) return Response.json({ id: "container" });

          if (url.pathname.endsWith("/media_publish")) {
            publishes++;

            if (ambiguous) throw new Error("lost response");

            return Response.json({ id: "post" });
          }

          return Response.json({ status_code: ready ? "FINISHED" : "IN_PROGRESS" });
        },
      });

      const social = createSocial({ backend: adapter });
      const native = social.native("default", { acknowledgeUnsafe: true });
      assert.ok(native);

      const first =
        kind === "reel"
          ? await native.publishReel({ account, videoUrl: "https://cdn.example/reel.mp4", context })
          : await native.publishStory({
              account,
              mediaUrl: "https://cdn.example/story.jpg",
              context,
            });

      assert.equal(first.state, "processing");
      assert.ok(first.delivery);
      const delivery = first.delivery;
      ready = true;

      if (ambiguous) await assert.rejects(() => social.posts.getDelivery(delivery));
      else assert.equal((await social.posts.getDelivery(delivery)).state, "published");
      assert.equal(
        (await social.posts.getDelivery(delivery)).state,
        ambiguous ? "unknown" : "published",
      );
      assert.equal(publishes, 1);
    }
  }
});

it("uses cursor-only Tags paging and login-specific fields, while replies require next", async () => {
  for (const flavor of ["instagram-login", "facebook-login"] as const) {
    const urls: URL[] = [];

    const adapter = instagram({
      auth: { accessToken: "token", accountId: "ig1", flavor },
      fetch: async (input) => {
        urls.push(new URL(String(input)));

        return Response.json({
          data: [{ id: "media", media_product_type: "FEED" }],
          paging: { cursors: { after: "next" } },
        });
      },
    });

    assert.ok(adapter.native);

    for (const method of [
      adapter.native.listMentions,
      adapter.native.mentions,
      adapter.native.listTaggedMedia,
    ]) {
      const result = await method({ account, context });
      assert.equal(result.nextCursor, "next");
    }

    assert.equal(
      urls[0]?.searchParams.get("fields")?.includes("media_product_type"),
      flavor === "facebook-login",
    );
    assert.equal(
      (await adapter.native.listCommentReplies({ account, commentId: "comment", context }))
        .nextCursor,
      undefined,
    );
  }
});

it("uses only public business discovery defaults", async () => {
  const urls: URL[] = [];

  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1", flavor: "facebook-login" },
    fetch: async (input) => {
      urls.push(new URL(String(input)));

      return Response.json({
        business_discovery: {
          id: "other",
          username: "other",
          name: "private",
          profile_picture_url: "private",
        },
      });
    },
  });

  assert.ok(adapter.graph?.getProfile);
  assert.ok(adapter.native);
  const profile = await adapter.graph.getProfile(account, { handle: "other" }, context);
  assert.equal(profile.displayName, undefined);
  assert.equal(profile.avatarUrl, undefined);
  await adapter.native.businessDiscovery({ account, username: "other", context });

  for (const url of urls)
    assert.doesNotMatch(
      url.searchParams.get("fields") ?? "",
      /\bname\b|profile_picture_url|follows_count/,
    );
});

it("limits image alt text and maps shareToFeed only to Reel and carousel parents", async () => {
  const bodies: JsonObject[] = [];
  let nextId = 0;

  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch: async (_input, init) => {
      if (init?.body) {
        bodies.push(object(await new Response(init.body).json()));

        return Response.json({ id: `id${nextId++}` });
      }

      return Response.json({ status_code: "FINISHED" });
    },
  });

  const image: MediaAttachment = {
    kind: "image",
    mimeType: "image/jpeg",
    width: 1080,
    height: 1080,
    altText: "image description",
    source: { kind: "https-url", url: "https://cdn.example/image.jpg" },
  };

  const video: MediaAttachment = {
    kind: "video",
    mimeType: "video/mp4",
    width: 1080,
    height: 1080,
    altText: "omit video",
    source: { kind: "https-url", url: "https://cdn.example/video.mp4" },
  };

  assert.ok(adapter.posts);

  const target = {
    targetIndex: 0,
    targetKey: "ig",
    account,
    content: { media: [image] },
    options: { shareToFeed: true },
  };

  assert.ok(
    adapter.posts
      .prepareTarget({ ...target, content: { media: [{ ...image, altText: "x".repeat(1001) }] } })
      .some((issue) => issue.code === "instagram.alt_text"),
  );
  await adapter.posts.publishTarget(target, context);
  await adapter.posts.publishTarget({ ...target, content: { media: [image, video] } }, context);
  await adapter.posts.publishTarget({ ...target, content: { media: [video] } }, context);
  assert.deepEqual(
    bodies.filter((body) => body["media_type"] !== undefined),
    [
      { video_url: "https://cdn.example/video.mp4", media_type: "VIDEO", is_carousel_item: true },
      { media_type: "CAROUSEL", children: "id2,id3", caption: "", share_to_feed: true },
      {
        video_url: "https://cdn.example/video.mp4",
        media_type: "REELS",
        share_to_feed: true,
        caption: "",
      },
    ],
  );
  assert.equal(bodies[0]?.["alt_text"], "image description");
  assert.equal(bodies[2]?.["alt_text"], "image description");
});

it("declares comment and insight grants separately from user counters and missing features", () => {
  for (const flavor of ["instagram-login", "facebook-login"] as const) {
    const entries = instagram({ auth: { accessToken: "token", accountId: "ig1", flavor } })
      .capabilities.capabilities;

    const commentScopes =
      flavor === "instagram-login"
        ? ["instagram_business_basic", "instagram_business_manage_comments"]
        : ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"];

    for (const operation of [
      "comments.read",
      "comments.write",
      "comments.moderate",
      "comments.delete",
      "comments.replies.read",
    ]) {
      assert.deepEqual(
        entries.find((entry) => entry.operation === operation)?.requiredScopes,
        commentScopes,
      );
    }

    assert.deepEqual(
      entries.find((entry) => entry.operation === "analytics.read")?.requiredScopes,
      flavor === "instagram-login"
        ? ["instagram_business_basic", "instagram_business_manage_insights"]
        : ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
    );
    assert.equal(
      entries.find((entry) => entry.operation === "product.tagging")?.availability,
      flavor === "instagram-login" ? "unsupported-by-platform" : "not-implemented-by-adapter",
    );
    assert.equal(
      entries.find((entry) => entry.operation === "messages.read")?.availability,
      "not-implemented-by-adapter",
    );
  }
});

it("creates durable native workflows before requesting Reel or Story containers", async () => {
  for (const kind of ["reel", "story"] as const) {
    let requests = 0;

    const adapter = instagram({
      auth: { accessToken: "token", accountId: "ig1" },
      workflowStore: {
        async create(input) {
          assert.equal(input.stage, "unknown");
          assert.equal(input.parentId, undefined);
          throw new Error("workflow storage unavailable");
        },
        async get() {
          return undefined;
        },
        async update() {
          throw new Error("unexpected update");
        },
        async claim() {
          return false;
        },
      },
      fetch: async () => {
        requests++;

        return Response.json({ id: "stranded-container" });
      },
    });

    assert.ok(adapter.native);
    const native = adapter.native;
    await assert.rejects(
      () =>
        kind === "reel"
          ? native.publishReel({ account, videoUrl: "https://cdn.example/reel.mp4", context })
          : native.publishStory({ account, mediaUrl: "https://cdn.example/story.jpg", context }),
      /workflow storage unavailable/,
    );
    assert.equal(requests, 0);
  }
});

it("retains native container recovery IDs when workflow updates reject", async () => {
  for (const kind of ["reel", "story"] as const) {
    for (const committed of [false, true]) {
      let saved: InstagramWorkflow | undefined;
      let rejectUpdates = true;
      let containers = 0;
      let publishes = 0;

      const store: InstagramWorkflowStore = {
        async create(input) {
          saved = { ...input, id: "workflow" };

          return saved;
        },
        async get() {
          return saved;
        },
        async update(id, update) {
          assert.ok(saved);
          assert.equal(id, saved.id);

          if (!rejectUpdates || committed) saved = { ...saved, ...update };

          if (rejectUpdates) throw new Error("storage update failed");

          return saved;
        },
        async claim() {
          return true;
        },
      };

      const fetch: typeof globalThis.fetch = async (input) => {
        const url = new URL(String(input));

        if (url.pathname.endsWith("/media")) {
          containers++;

          return Response.json({ id: "container" });
        }

        if (url.pathname.endsWith("/media_publish")) {
          publishes++;

          return Response.json({ id: "published" });
        }

        return Response.json({ status_code: "FINISHED" });
      };

      const options = {
        auth: { accessToken: "token", accountId: "ig1" },
        workflowStore: store,
        fetch,
      };

      const adapter = instagram(options);
      assert.ok(adapter.native);
      const native = adapter.native;
      let recovery: JsonObject | undefined;

      try {
        if (kind === "reel")
          await native.publishReel({ account, videoUrl: "https://cdn.example/reel.mp4", context });
        else
          await native.publishStory({
            account,
            mediaUrl: "https://cdn.example/story.jpg",
            context,
          });
      } catch (error) {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, "upstream_failure");
        assert.equal(error.retryDisposition.kind, "reconcile-first");
        assert.deepEqual(error.details, { workflowId: "workflow", containerId: "container" });
        recovery = error.toJSON().details;
      }

      assert.equal(containers, 1);
      assert.equal(publishes, 0);
      assert.ok(recovery);
      const workflowId = string(recovery["workflowId"]);
      const containerId = string(recovery["containerId"]);

      rejectUpdates = false;
      await store.update(workflowId, { parentId: containerId, stage: "parent" });
      const reconstructed = instagram(options);
      assert.ok(reconstructed.native);
      const outcome = await reconstructed.native.resumePublication(account, workflowId, context);
      assert.equal(outcome.state, "published");
      assert.equal(containers, 1);
      assert.equal(publishes, 1);
    }
  }
});

it("retains published post recovery IDs when final workflow updates reject", async () => {
  for (const kind of ["reel", "story"] as const) {
    for (const committed of [false, true]) {
      let saved: InstagramWorkflow | undefined;
      let rejectUpdates = true;
      let containers = 0;
      let publishes = 0;

      const store: InstagramWorkflowStore = {
        async create(input) {
          saved = { ...input, id: "workflow" };

          return saved;
        },
        async get() {
          return saved;
        },
        async update(id, update) {
          assert.ok(saved);
          assert.equal(id, saved.id);

          if (!rejectUpdates || !update.nativeId || committed) saved = { ...saved, ...update };

          if (rejectUpdates && update.nativeId) throw new Error("storage update failed");

          return saved;
        },
        async claim() {
          return true;
        },
      };

      const fetch: typeof globalThis.fetch = async (input) => {
        const url = new URL(String(input));

        if (url.pathname.endsWith("/media")) {
          containers++;

          return Response.json({ id: "container" });
        }

        if (url.pathname.endsWith("/media_publish")) {
          publishes++;

          return Response.json({ id: "published" });
        }

        return Response.json({ status_code: "FINISHED" });
      };

      const options = {
        auth: { accessToken: "token", accountId: "ig1" },
        workflowStore: store,
        fetch,
      };

      const adapter = instagram(options);
      assert.ok(adapter.native);
      const native = adapter.native;

      const published =
        kind === "reel"
          ? await native.publishReel({ account, videoUrl: "https://cdn.example/reel.mp4", context })
          : await native.publishStory({
              account,
              mediaUrl: "https://cdn.example/story.jpg",
              context,
            });

      assert.equal(published.state, "published");

      if (published.state !== "published") assert.fail("expected confirmed publication");
      assert.ok(published.delivery);
      assert.equal(containers, 1);
      assert.equal(publishes, 1);
      const workflowId = published.delivery.deliveryId;
      assert.ok(saved);
      const containerId = string(saved.parentId);
      const postId = published.post.postId;
      assert.equal(workflowId, "workflow");
      assert.equal(containerId, "container");
      assert.equal(postId, "published");

      rejectUpdates = false;
      await store.update(workflowId, {
        parentId: containerId,
        nativeId: postId,
        stage: "published",
      });
      const reconstructed = instagram(options);
      assert.ok(reconstructed.native);
      const outcome = await reconstructed.native.resumePublication(account, workflowId, context);
      assert.equal(outcome.state, "published");
      assert.equal(containers, 1);
      assert.equal(publishes, 1);
    }
  }
});

it("preserves confirmed publication through the normalized path when the final save fails", async () => {
  for (const carousel of [false, true]) {
    for (const committed of [false, true]) {
      let saved: InstagramWorkflow | undefined;
      let publishes = 0;

      const store: InstagramWorkflowStore = {
        async create(input) {
          saved = { ...input, id: "workflow" };

          return saved;
        },
        async get() {
          return saved;
        },
        async update(id, update) {
          assert.ok(saved);
          assert.equal(id, saved.id);

          if (!update.nativeId || committed) saved = { ...saved, ...update };

          if (update.nativeId) throw new Error("final save unavailable");

          return saved;
        },
        async claim() {
          return true;
        },
      };

      const social = createSocial({
        backend: instagram({
          auth: { accessToken: "token", accountId: "ig1" },
          workflowStore: store,
          fetch: async (input) => {
            const url = new URL(String(input));

            if (url.pathname.endsWith("/media")) return Response.json({ id: "container" });

            if (url.pathname.endsWith("/media_publish")) {
              publishes++;

              return Response.json({ id: "confirmed-post" });
            }

            return Response.json({ status_code: "FINISHED" });
          },
        }),
      });

      const image: MediaAttachment = {
        kind: "image",
        mimeType: "image/jpeg",
        width: 1080,
        height: 1080,
        source: { kind: "https-url", url: "https://cdn.example/image.jpg" },
      };

      const result = await social.posts.publish({
        content: { media: carousel ? [image, image] : [image] },
        targets: [{ account }],
      });

      const outcome = result.outcomes[0];
      assert.ok(outcome);
      assert.equal(outcome.state, "published");

      if (outcome.state !== "published") assert.fail("confirmed publication must retain its post");
      assert.equal(outcome.post.postId, "confirmed-post");
      assert.equal(outcome.delivery?.deliveryId, "workflow");
      assert.equal(outcome.backendState, "PUBLISHED");
      assert.equal(result.status, "complete");
      assert.ok(outcome.delivery);
      assert.equal(
        (await social.posts.getDelivery(outcome.delivery)).state,
        committed ? "published" : "unknown",
      );
      assert.equal(publishes, 1);
      assert.ok(saved);
      assert.equal(saved.parentId, "container");
      assert.equal(saved.stage, committed ? "published" : "unknown");
    }
  }
});
