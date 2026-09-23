/* oxlint-disable anti-slop/require-readable-spacing -- compact mocked-fetch fixtures keep request assertions local. */
import { strict as assert } from "node:assert";
import { it } from "node:test";
import {
  instagram,
  type InstagramWorkflow,
  type InstagramWorkflowStore,
} from "../src/platforms/instagram.js";
import {
  connectedAccountRef,
  createSocial,
  type AdapterOperationContext,
} from "../src/core/index.js";

const context = (backend = "instagram"): AdapterOperationContext => ({
  backendInstance: backend,
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10000 },
});

const target = (
  account: ReturnType<typeof connectedAccountRef>,
  media = [
    {
      kind: "image" as const,
      source: { kind: "https-url" as const, url: "https://cdn.example/image.jpg" },
      mimeType: "image/jpeg",
      width: 1080,
      height: 1080,
    },
  ],
) => ({ targetIndex: 0, targetKey: "instagram", account, content: { text: "caption", media } });

class TestWorkflowStore implements InstagramWorkflowStore {
  readonly rows = new Map<string, InstagramWorkflow>();
  readonly claims = new Set<string>();
  private next = 1;
  async create(input: Omit<InstagramWorkflow, "id">) {
    const row = { ...input, id: `wf${this.next++}` };
    this.rows.set(row.id, row);

    return row;
  }
  async get(id: string) {
    return this.rows.get(id);
  }
  async update(id: string, update: Partial<InstagramWorkflow>) {
    const row = { ...this.rows.get(id)!, ...update, id };
    this.rows.set(id, row);

    return row;
  }
  async claim(id: string) {
    if (this.claims.has(id)) return false;
    this.claims.add(id);

    return true;
  }
  async release(id: string) {
    this.claims.delete(id);
  }
}

it("validates professional-account media and publishes an image container", async () => {
  const calls: string[] = [];

  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch: async (input) => {
      calls.push(String(input));

      if (String(input).endsWith("/media"))
        return new Response(JSON.stringify({ id: "container" }));

      if (String(input).includes("status_code"))
        return new Response(JSON.stringify({ status_code: "FINISHED" }));

      return new Response(JSON.stringify({ id: "post1" }));
    },
  });

  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  assert.equal(adapter.posts?.prepareTarget(target(account)).length, 0);
  const result = await adapter.posts?.publishTarget(target(account), context());
  assert.equal(result?.state, "published");
  assert.ok(calls.some((call) => call.endsWith("/media")));
});

it("normalizes the authorized Instagram profile without a selector", async () => {
  const calls: string[] = [];
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch: async (input) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          id: "ig1",
          username: "owner",
          name: "Owner",
          biography: "Bio",
          profile_picture_url: "https://cdn.example/avatar.jpg",
        }),
      );
    },
  });
  const account = connectedAccountRef({
    backend: "default",
    platform: "instagram",
    accountId: "ig1",
  });

  const profile = await adapter.graph?.getProfile(account, {}, context("default"));
  assert.equal(profile.ref.profileId, "ig1");
  assert.equal(profile.displayName, "Owner");
  assert.equal(profile.handle, "owner");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /fields=.*username%2Cname/);
});

it("uses Facebook Login business discovery for handle profiles", async () => {
  const calls: string[] = [];
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1", flavor: "facebook-login" },
    fetch: async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ business_discovery: { id: "ig2", username: "other" } }));
    },
  });
  const social = createSocial({ backend: adapter });
  const account = connectedAccountRef({
    backend: "default",
    platform: "instagram",
    accountId: "ig1",
  });

  const profile = await social.graph.getProfile(account, { handle: "other" });
  assert.equal(profile.ref.profileId, "ig2");
  assert.equal(profile.handle, "other");
  assert.match(calls[0]!, /business_discovery.username%28other%29/);
});

it("makes mentions an alias for the paginated tags reader", async () => {
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1", flavor: "facebook-login" },
    fetch: async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "media1" }],
          paging: { cursors: { after: "next" }, next: "https://graph.facebook.com/next" },
        }),
      ),
  });
  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });
  const result = await adapter.native?.mentions({ account, context: context() });
  assert.deepEqual(result, { items: [{ id: "media1" }], nextCursor: "next" });
});

it("stops paginating when Graph omits paging.next", async () => {
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1", flavor: "facebook-login" },
    fetch: async () =>
      new Response(
        JSON.stringify({ data: [{ id: "media1" }], paging: { cursors: { after: "last" } } }),
      ),
  });
  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });
  const result = await adapter.native?.mentions({ account, context: context() });
  assert.deepEqual(result, { items: [{ id: "media1" }] });
});

it("returns processing for a continuation handle and rejects cross-account references", async () => {
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch: async (input) =>
      String(input).includes("status_code")
        ? new Response(JSON.stringify({ status_code: "IN_PROGRESS" }))
        : new Response(JSON.stringify({ id: "x" })),
  });

  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  const result = await adapter.native?.publishContainer(account, "container", context());
  assert.equal(result?.state, "processing");
  await assert.rejects(() =>
    adapter.posts?.get(
      {
        kind: "platform-post",
        version: 1,
        backend: "instagram",
        platform: "instagram",
        accountId: "other",
        postId: "p",
      },
      context(),
    ),
  );
});

it("does not treat a PUBLISHED container ID as the native media ID", async () => {
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch: async () => new Response(JSON.stringify({ status_code: "PUBLISHED" })),
  });

  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  const result = await adapter.native?.publishContainer(account, "container", context());
  assert.equal(result?.state, "unknown");
});

it("treats ERROR and EXPIRED containers as terminal failures without publishing", async () => {
  for (const status of ["ERROR", "EXPIRED"] as const) {
    let publishCalls = 0;

    const adapter = instagram({
      auth: { accessToken: "token", accountId: "ig1" },
      fetch: async (_input, init) => {
        if (init?.method === "POST") publishCalls++;

        return new Response(JSON.stringify({ status_code: status }));
      },
    });

    const account = connectedAccountRef({
      backend: "instagram",
      platform: "instagram",
      accountId: "ig1",
    });

    const result = await adapter.native?.publishContainer(account, "container", context());
    assert.equal(result?.state, "failed");
    assert.equal(publishCalls, 0);
  }
});

it("reconstructs a carousel workflow and resumes without recreating children", async () => {
  const store = new TestWorkflowStore();
  let ready = false;
  const calls: string[] = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);

    if (init?.method === "POST" && url.endsWith("/media")) {
      const count = calls.filter((x) => x.includes("POST") && x.endsWith("/media")).length;

      return new Response(
        JSON.stringify({ id: count === 1 ? "c1" : count === 2 ? "c2" : "parent" }),
      );
    }

    if (init?.method !== "POST")
      return new Response(JSON.stringify({ status_code: ready ? "FINISHED" : "IN_PROGRESS" }));

    return new Response(JSON.stringify({ id: "post" }));
  };

  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  const media = [
    {
      kind: "image" as const,
      source: { kind: "https-url" as const, url: "https://cdn.example/1.jpg" },
      mimeType: "image/jpeg",
      width: 100,
      height: 100,
    },
    {
      kind: "image" as const,
      source: { kind: "https-url" as const, url: "https://cdn.example/2.jpg" },
      mimeType: "image/jpeg",
      width: 100,
      height: 100,
    },
  ];

  const first = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch,
    workflowStore: store,
  });

  const pending = await first.posts?.publishTarget(target(account, media), context());
  assert.equal(pending?.state, "processing");
  const workflowId = pending?.delivery?.deliveryId;
  assert.ok(workflowId);
  assert.deepEqual([...store.rows.keys()], [workflowId]);
  ready = true;

  const second = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch,
    workflowStore: store,
  });

  const resumed = await second.posts?.getDelivery(
    {
      backend: "instagram",
      platform: "instagram",
      accountId: "ig1",
      deliveryId: workflowId,
    },
    context(),
  );
  assert.equal(resumed?.state, "published");
  assert.equal(calls.filter((x) => x.includes("POST") && x.endsWith("/media")).length, 3);
});

it("polls a single video workflow through getDelivery and publishes after FINISHED", async () => {
  const store = new TestWorkflowStore();
  let statusCode = "IN_PROGRESS";
  const calls: Array<{ method: string; body: string }> = [];
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    workflowStore: store,
    fetch: async (input, init) => {
      calls.push({ method: init?.method ?? "GET", body: String(init?.body ?? "") });
      if (init?.method === "POST" && String(input).endsWith("/media"))
        return new Response(JSON.stringify({ id: "video-container" }));
      if (init?.method === "POST") return new Response(JSON.stringify({ id: "published-media" }));
      return new Response(JSON.stringify({ status_code: statusCode }));
    },
  });
  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });
  const pending = await adapter.posts?.publishTarget(
    target(account, [
      {
        kind: "video",
        source: { kind: "https-url", url: "https://cdn.example/video.mp4" },
        mimeType: "video/mp4",
        width: 1080,
        height: 1920,
      },
    ]),
    context(),
  );
  const deliveryId = pending?.delivery?.deliveryId;
  assert.equal(pending?.state, "processing");
  assert.ok(deliveryId);
  assert.equal(deliveryId, [...store.rows.keys()][0]);
  statusCode = "FINISHED";
  const result = await adapter.posts?.getDelivery(
    { backend: "instagram", platform: "instagram", accountId: "ig1", deliveryId },
    context(),
  );
  assert.equal(result?.state, "published");
  assert.equal(result?.post?.postId, "published-media");
  assert.ok(
    calls.some(({ method, body }) => method === "POST" && body.includes("video-container")),
  );
});

it("serializes concurrent carousel resumes and rejects unauthorized handles", async () => {
  const store = new TestWorkflowStore();

  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    workflowStore: store,
    fetch: async (input, init) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ id: "parent" }))
        : new Response(JSON.stringify({ status_code: "FINISHED" })),
  });

  const workflow = await store.create({
    backend: "instagram",
    accountId: "ig1",
    childIds: ["c1", "c2"],
    caption: "x",
    stage: "children",
  });

  const [a, b] = await Promise.all([
    adapter.native?.resumePublication(account, workflow.id, context()),
    adapter.native?.resumePublication(account, workflow.id, context()),
  ]);

  assert.equal([a?.state, b?.state].filter((state) => state === "published").length, 1);
  assert.equal([a?.state, b?.state].filter((state) => state === "processing").length, 1);
  await assert.rejects(() =>
    adapter.native?.resumePublication(
      connectedAccountRef({ backend: "instagram", platform: "instagram", accountId: "other" }),
      workflow.id,
      context(),
    ),
  );
});

it("reconstructs a single media workflow and never replays an uncertain publish", async () => {
  const store = new TestWorkflowStore();

  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  let publishes = 0;

  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      publishes++;

      if (publishes === 1) return new Response(JSON.stringify({ id: "container" }));

      if (publishes === 2) throw new Error("connection lost after publish");

      return new Response(JSON.stringify({ id: "should-not-replay" }));
    }

    return new Response(JSON.stringify({ status_code: "FINISHED" }));
  };

  const first = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch,
    workflowStore: store,
  });

  await assert.rejects(() => first.posts?.publishTarget(target(account), context()));
  const workflowId = [...store.rows.keys()][0];
  assert.ok(workflowId);

  const second = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch,
    workflowStore: store,
  });

  const resumed = await second.native?.resumePublication(account, workflowId, context());
  assert.equal(resumed?.state, "unknown");
  assert.equal(publishes, 2);
});

it("keeps an ambiguous marker when persistence fails after accepted publish", async () => {
  const store = new TestWorkflowStore();
  let failNativePersist = true;
  const originalUpdate = store.update.bind(store);
  store.update = async (id, update) => {
    if (failNativePersist && update.nativeId) {
      failNativePersist = false;
      throw new Error("persistence unavailable");
    }

    return originalUpdate(id, update);
  };

  let postCalls = 0;

  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      postCalls++;

      return new Response(JSON.stringify({ id: postCalls === 1 ? "container" : "native" }));
    }

    return new Response(JSON.stringify({ status_code: "FINISHED" }));
  };

  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch,
    workflowStore: store,
  });

  await assert.rejects(() => adapter.posts?.publishTarget(target(account), context()));
  const id = [...store.rows.keys()][0];
  const resumed = await adapter.native?.resumePublication(account, id, context());
  assert.equal(resumed?.state, "unknown");
  assert.equal(postCalls, 2);
});

it("moderates comments, toggles media comments, and deletes comments with Graph mutations", async () => {
  const calls: Array<{ method: string; url: URL }> = [];
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch: async (input, init) => {
      calls.push({ method: init?.method ?? "GET", url: new URL(String(input)) });
      return new Response(JSON.stringify({ success: true }));
    },
  });
  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  await adapter.native?.moderateComment({
    account,
    commentId: "comment-1",
    hidden: true,
    context: context(),
  });
  await adapter.native?.moderateComment({
    account,
    commentId: "comment-1",
    hidden: false,
    context: context(),
  });
  await adapter.native?.setCommentsEnabled({
    account,
    mediaId: "media-1",
    enabled: false,
    context: context(),
  });
  await adapter.native?.deleteComment({ account, commentId: "comment-1", context: context() });

  assert.deepEqual(
    calls.map(({ method, url }) => [method, url.pathname, Object.fromEntries(url.searchParams)]),
    [
      ["POST", "/v25.0/comment-1", { hide: "true" }],
      ["POST", "/v25.0/comment-1", { hide: "false" }],
      ["POST", "/v25.0/media-1", { comment_enabled: "false" }],
      ["DELETE", "/v25.0/comment-1", {}],
    ],
  );
});

it("lists comment replies across cursors and keeps an empty page empty", async () => {
  const urls: URL[] = [];
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch: async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      return urls.length === 1
        ? new Response(
            JSON.stringify({
              data: [{ id: "reply-1", text: "first" }],
              paging: {
                cursors: { after: "reply-cursor" },
                next: "https://graph.instagram.com/next",
              },
            }),
          )
        : new Response(JSON.stringify({ data: [] }));
    },
  });
  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  const first = await adapter.native?.listCommentReplies({
    account,
    commentId: "comment-1",
    limit: 10,
    context: context(),
  });
  const second = await adapter.native?.listCommentReplies({
    account,
    commentId: "comment-1",
    cursor: first?.nextCursor,
    limit: 10,
    context: context(),
  });

  assert.deepEqual(first?.items, [{ id: "reply-1", text: "first" }]);
  assert.equal(first?.nextCursor, "reply-cursor");
  assert.deepEqual(second, { items: [] });
  assert.equal(urls[1]?.searchParams.get("after"), "reply-cursor");
});

it("lists tagged media mentions with cursor pagination and handles an empty data array", async () => {
  const urls: URL[] = [];
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1", flavor: "facebook-login" },
    fetch: async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      return urls.length === 1
        ? new Response(
            JSON.stringify({
              data: [{ id: "media-1", caption: "hello" }],
              paging: {
                cursors: { after: "mention-cursor" },
                next: "https://graph.instagram.com/next",
              },
            }),
          )
        : new Response(JSON.stringify({ data: [] }));
    },
  });
  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  const first = await adapter.native?.listTaggedMedia({
    account,
    limit: 5,
    context: context(),
  });
  const second = await adapter.native?.listTaggedMedia({
    account,
    cursor: first?.nextCursor,
    limit: 5,
    context: context(),
  });

  assert.deepEqual(first?.items, [{ id: "media-1", caption: "hello" }]);
  assert.equal(first?.nextCursor, "mention-cursor");
  assert.deepEqual(second, { items: [] });
  assert.equal(urls[0]?.host, "graph.facebook.com");
  assert.equal(urls[0]?.pathname, "/v25.0/ig1/tags");
  assert.equal(urls[1]?.searchParams.get("after"), "mention-cursor");
});

it("requires Facebook Login for business discovery and specific mention lookups", async () => {
  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch: async () => new Response(JSON.stringify({ data: [] })),
  });

  await assert.rejects(
    () =>
      adapter.native?.businessDiscovery({
        account,
        username: "other",
        context: context(),
      }),
    /Facebook Login/,
  );
  await assert.rejects(
    () => adapter.native?.mentionedMedia({ account, mediaId: "media-1", context: context() }),
    /Facebook Login/,
  );
});

it("uses ID-scoped field expansions for Facebook mention lookups", async () => {
  const urls: URL[] = [];
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1", flavor: "facebook-login" },
    fetch: async (input) => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify({ mentioned_media: { id: "media-1" }, id: "ig1" }));
    },
  });
  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  await adapter.native?.mentionedMedia({ account, mediaId: "media-1", context: context() });
  await adapter.native?.mentionedComment({ account, commentId: "comment-1", context: context() });

  assert.match(urls[0]?.searchParams.get("fields") ?? "", /mentioned_media\.media_id\(media-1\)/);
  assert.match(
    urls[1]?.searchParams.get("fields") ?? "",
    /mentioned_comment\.comment_id\(comment-1\)/,
  );
});

it("rejects tags mentions with Instagram Login through the public native facade", async () => {
  let requests = 0;
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1" },
    fetch: async (_input) => {
      requests++;
      return new Response(JSON.stringify({ data: [{ id: "mention-1" }] }));
    },
  });
  const social = createSocial({ backend: adapter });
  const account = connectedAccountRef({
    backend: "default",
    platform: "instagram",
    accountId: "ig1",
  });
  const native = social.native("default", { acknowledgeUnsafe: true });
  await assert.rejects(
    () => native?.listMentions({ account, context: context("default") }),
    /Facebook Login/,
  );
  assert.equal(requests, 0);
});

it("uses user_id for an Instagram Login own-profile response", async () => {
  let url: URL | undefined;
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "user-1" },
    fetch: async (input) => {
      url = new URL(String(input));
      return new Response(
        JSON.stringify({ user_id: "user-1", id: "app-scoped", username: "owner", name: "Owner" }),
      );
    },
  });
  const social = createSocial({ backend: adapter });
  const account = connectedAccountRef({
    backend: "default",
    platform: "instagram",
    accountId: "user-1",
  });
  const profile = await social.graph.getProfile(account, {});
  assert.equal(profile.ref.profileId, "user-1");
  assert.match(url?.searchParams.get("fields") ?? "", /user_id/);
});

it("searches hashtags, validates identifiers, and rejects empty names", async () => {
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1", flavor: "facebook-login" },
    fetch: async () => new Response(JSON.stringify({ data: [{ id: "tag-1" }] })),
  });
  const social = createSocial({ backend: adapter });
  const account = connectedAccountRef({
    backend: "default",
    platform: "instagram",
    accountId: "ig1",
  });
  const native = social.native("default", { acknowledgeUnsafe: true });
  assert.deepEqual(
    await native?.hashtagSearch({ account, hashtag: "#coffee", context: context("default") }),
    { data: [{ id: "tag-1" }] },
  );
  await assert.rejects(
    () => native?.hashtagSearch({ account, hashtag: "#", context: context("default") }),
    /non-empty hashtag/,
  );
});

it("maps malformed Instagram responses to an upstream SocialError", async () => {
  const adapter = instagram({
    auth: { accessToken: "token", accountId: "ig1", flavor: "facebook-login" },
    fetch: async () => new Response(JSON.stringify(null)),
  });
  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });
  await assert.rejects(
    () => adapter.native?.listMentions({ account, context: context("instagram") }),
    { code: "upstream_failure" },
  );
});
