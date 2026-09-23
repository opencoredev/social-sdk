/* oxlint-disable anti-slop/require-readable-spacing -- provider fixture setup stays grouped by scenario. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { threads, MemoryThreadsWorkflowStore } from "../src/platforms/threads.js";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";
import { SocialError } from "../src/core/errors.js";

const account = connectedAccountRef({ backend: "default", platform: "threads", accountId: "u1" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "fixture",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

test("Threads keyword search sends the documented q and filter parameters", async () => {
  let requested: URL | undefined;
  const adapter = threads({
    auth: { userId: "u1", accessToken: "fixture" },
    fetch: async (input) => {
      requested = new URL(String(input));
      return Response.json({
        data: [{ id: "post-1" }],
        paging: { cursors: { after: "next" }, next: "https://graph.threads.net/next" },
      });
    },
  });

  const result = await adapter.native!.search({
    account,
    query: "open source",
    searchType: "RECENT",
    searchMode: "TAG",
    mediaType: "TEXT",
    since: "2026-01-01",
    until: "2026-02-01",
    limit: 25,
    authorUsername: "alice",
    context,
  });

  assert.equal(requested?.pathname, "/v1.0/keyword_search");
  assert.equal(requested?.searchParams.get("q"), "open source");
  assert.equal(requested?.searchParams.get("query"), null);
  assert.equal(requested?.searchParams.get("search_type"), "RECENT");
  assert.equal(requested?.searchParams.get("search_mode"), "TAG");
  assert.equal(requested?.searchParams.get("media_type"), "TEXT");
  assert.equal(requested?.searchParams.get("after"), null);
  assert.ok(Array.isArray(result["data"]));
  assert.equal(result["data"].length, 1);
});

test("Threads search rejects empty query and invalid limits", async () => {
  const adapter = threads({
    auth: { userId: "u1", accessToken: "fixture" },
    fetch: async () => Response.json({ data: [] }),
  });

  await assert.rejects(
    adapter.native!.search({ account, query: " ", context }),
    /search query is required/,
  );
  await assert.rejects(
    adapter.native!.search({ account, query: "x", limit: 101, context }),
    /limit must be an integer from 1 through 100/,
  );
  const scopeError = await adapter
    .search!.posts(account, { query: "x", scope: "all" }, context)
    .catch((error) => error);
  assert.ok(scopeError instanceof SocialError);
  assert.equal(scopeError.code, "invalid_input");
  assert.match(scopeError.message, /scope 'all'/);
});

test("Threads keyword search requests the documented fields", async () => {
  let requested: URL | undefined;
  const adapter = threads({
    auth: { userId: "u1", accessToken: "fixture" },
    fetch: async (input) => {
      requested = new URL(String(input));
      return Response.json({ data: [] });
    },
  });

  await adapter.native!.search({ account, query: "hello", context });
  assert.equal(
    requested?.searchParams.get("fields"),
    "id,text,media_type,media_url,permalink,timestamp,username,shortcode,is_quote_post",
  );
});

test("Threads profile lookup maps current fields without treating the handle as an ID", async () => {
  let requested: URL | undefined;
  const adapter = threads({
    auth: { userId: "u1", accessToken: "fixture" },
    fetch: async (input) => {
      requested = new URL(String(input));
      return Response.json({
        username: "alice",
        name: "Alice",
        profile_picture_url: "https://img",
        biography: "Bio",
      });
    },
  });

  const profile = await adapter.graph!.getProfile!(account, { handle: "alice" }, context);
  assert.equal(requested?.pathname, "/v1.0/profile_lookup");
  assert.equal(
    requested?.searchParams.get("fields"),
    "id,username,name,profile_picture_url,biography,is_verified",
  );
  assert.equal(profile.handle, "alice");
  assert.equal(profile.avatarUrl, "https://img");
  assert.equal(profile.bio, "Bio");
  assert.notEqual(profile.ref.profileId, "alice");
  assert.equal(profile.native?._profileIdUnavailable, true);
});

test("Threads native reply management routes preserve fields and cursors", async () => {
  const requests: URL[] = [];
  const adapter = threads({
    auth: { userId: "u1", accessToken: "fixture" },
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      return Response.json({
        data: [],
        paging: { cursors: { after: "next" }, next: "https://graph.threads.net/next" },
      });
    },
  });

  await adapter.native!.mentions({ account, cursor: "m0", context });
  await adapter.native!.listConversation({ account, mediaId: "media", cursor: "c0", context });
  await adapter.native!.listPendingReplies({
    account,
    mediaId: "media",
    cursor: "p0",
    approvalStatus: "pending",
    context,
  });
  await adapter.native!.hideReply({ account, replyId: "reply", hide: true, context });

  assert.equal(requests[0]?.pathname, "/v1.0/u1/mentions");
  assert.equal(requests[0]?.searchParams.get("after"), "m0");
  assert.equal(requests[1]?.pathname, "/v1.0/media/conversation");
  assert.equal(requests[1]?.searchParams.get("after"), "c0");
  assert.equal(
    requests[1]?.searchParams.get("fields"),
    "id,text,username,permalink,timestamp,is_reply,hide_status",
  );
  assert.equal(requests[2]?.pathname, "/v1.0/media/pending_replies");
  assert.equal(requests[2]?.searchParams.get("approval_status"), "pending");
  assert.equal(requests[2]?.searchParams.get("after"), "p0");
  assert.equal(requests[3]?.pathname, "/v1.0/reply/manage_reply");
  assert.equal(requests[3]?.searchParams.get("hide"), "true");
});

test("Threads exposes normalized search, app-scoped profiles, and reply moderation", async () => {
  const requests: Array<{ url: URL; method: string }> = [];
  const adapter = threads({
    auth: { userId: "u1", accessToken: "fixture" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, method: init?.method ?? "GET" });
      if (url.pathname.endsWith("/keyword_search"))
        return Response.json({
          data: [],
          paging: { cursors: { after: "next" }, next: "https://graph.threads.net/next" },
        });
      if (url.pathname.endsWith("/manage_reply") || url.pathname.endsWith("/manage_pending_reply"))
        return Response.json({ success: true });
      return Response.json({ id: "u1", username: "alice", name: "Alice" });
    },
  });

  const page = await adapter.search!.posts(account, { query: "hello" }, context);
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, "next");
  const profile = await adapter.graph!.getProfile!(account, { profileId: "u1" }, context);
  assert.equal(profile.handle, "alice");
  await adapter.native!.hideReply({ account, replyId: "reply-1", hide: true, context });
  await adapter.native!.managePendingReply({
    account,
    replyId: "reply-1",
    approve: false,
    context,
  });
  assert.equal(requests.at(-2)?.url.pathname, "/v1.0/reply-1/manage_reply");
  assert.equal(requests.at(-1)?.url.searchParams.get("approve"), "false");
});

for (const kind of ["image", "video"] as const)
  test(`Threads reconstructs ${kind} workflow and uses POST for both writes`, async () => {
    const store = new MemoryThreadsWorkflowStore();
    const writes: URL[] = [];

    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/threads") || url.pathname.endsWith("/threads_publish")) {
        assert.equal(init?.method, "POST");
        writes.push(url);

        return Response.json({ id: url.pathname.endsWith("/threads") ? "container" : "native" });
      }

      assert.equal(init?.method, "GET");

      return Response.json({ id: "container", status: "FINISHED" });
    };

    const options = {
      auth: { userId: "u1", accessToken: "fixture-token" },
      workflowStore: store,
      fetch: fetcher,
    };

    const first = threads(options);

    const outcome = await first.posts!.publishTarget(
      {
        targetIndex: 0,
        targetKey: "t",
        account,
        content: {
          text: "caption",
          media: [{ kind, source: { kind: "https-url", url: `https://cdn.example.test/${kind}` } }],
        },
        options: { replyControl: "mentionedOnly" },
      },
      context,
    );

    assert.equal(writes.length, 2);
    const id = outcome.delivery!.deliveryId;
    assert.equal(outcome.state, "published");
    assert.equal(writes[0]?.searchParams.get("media_type"), kind.toUpperCase());
    assert.equal(writes[0]?.searchParams.get(`${kind}_url`), `https://cdn.example.test/${kind}`);
    assert.equal(writes[0]?.searchParams.get("reply_control"), "mentioned_only");
    await first.native!.resumePublication(account, id, context);
    assert.equal(writes.length, 2);
  });

test("Threads never republishes after a lost create response or a PUBLISHED container without native ID", async () => {
  for (const scenario of ["lost-parent", "lost-publish", "published-container"]) {
    const store = new MemoryThreadsWorkflowStore();
    let writes = 0;

    const adapter = threads({
      auth: { userId: "u1", accessToken: "fixture" },
      workflowStore: store,
      fetch: async (input, init) => {
        const url = new URL(String(input));

        if (init?.method === "POST") {
          writes++;

          if (scenario === "lost-parent" || url.pathname.endsWith("threads_publish"))
            throw new Error("lost response");

          return Response.json({ id: "container" });
        }

        return Response.json({
          status: scenario === "published-container" ? "PUBLISHED" : "FINISHED",
        });
      },
    });

    const initial = await adapter.posts!.publishTarget(
      { targetIndex: 0, targetKey: "t", account, content: { text: "hello" } },
      context,
    );

    const id = initial.delivery!.deliveryId;

    try {
      await adapter.native!.resumePublication(account, id, context);
    } catch {
      /* A lost parent response is surfaced as an error; persisted workflow remains unknown. */
    }

    const count = writes;
    assert.equal((await adapter.native!.resumePublication(account, id, context)).state, "unknown");
    assert.equal(writes, count);
    await assert.rejects(
      adapter.native!.resumePublication({ ...account, accountId: "other" }, id, context),
    );
  }
});

test("Threads reads insight values from the documented values array", async () => {
  const adapter = threads({
    auth: { userId: "u1", accessToken: "fixture" },
    fetch: async () =>
      Response.json({
        data: [
          { name: "views", values: [{ value: 17 }] },
          { name: "likes", values: [] },
        ],
      }),
  });

  const metrics = await adapter.analytics!.getPostMetrics(
    { ...account, kind: "platform-post", postId: "post" },
    context,
  );

  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]?.value, 17);
});

test("Threads persists each carousel child before waiting and serializes concurrent resumes", async () => {
  const store = new MemoryThreadsWorkflowStore();

  let children = 0,
    parents = 0,
    publications = 0;

  let finished = false;

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));

    if (init?.method === "POST" && url.pathname.endsWith("/threads")) {
      if (url.searchParams.get("is_carousel_item") === "true")
        return Response.json({ id: `child-${++children}` });
      parents++;

      return Response.json({ id: "parent" });
    }

    if (init?.method === "POST") {
      publications++;

      return Response.json({ id: "native" });
    }

    return Response.json({ status: finished ? "FINISHED" : "IN_PROGRESS" });
  };

  const options = {
    auth: { userId: "u1", accessToken: "fixture" },
    workflowStore: store,
    fetch: fetcher,
  };

  const first = threads(options);

  const outcome = await first.posts!.publishTarget(
    {
      targetIndex: 0,
      targetKey: "t",
      account,
      content: {
        media: [1, 2].map((i) => ({
          kind: "image",
          source: { kind: "https-url", url: `https://cdn.example.test/${i}.jpg` },
        })),
      },
    },
    context,
  );

  const id = outcome.delivery!.deliveryId;
  assert.equal(children, 2);
  assert.equal((await first.native!.resumePublication(account, id, context)).state, "processing");
  assert.equal(children, 2);
  assert.equal(parents, 0);
  finished = true;
  const restarted = threads(options);

  const results = await Promise.all([
    restarted.native!.resumePublication(account, id, context),
    first.native!.resumePublication(account, id, context),
  ]);

  assert.ok(results.some((result) => result.state === "published"));
  assert.equal(children, 2);
  assert.equal(parents, 1);
  assert.equal(publications, 1);
});

test("stops Threads search paging when Graph omits paging.next", async () => {
  const adapter = threads({
    auth: { userId: "u1", accessToken: "fixture" },
    fetch: async () =>
      Response.json({ data: [{ id: "post-1" }], paging: { cursors: { after: "stale" } } }),
  });

  const page = await adapter.search!.posts(account, { query: "hello" }, context);
  assert.equal(page.nextCursor, undefined);
});
