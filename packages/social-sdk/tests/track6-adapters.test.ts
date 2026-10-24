import { strict as assert } from "node:assert";
import { it } from "node:test";
import {
  connectedAccountRef,
  platformPostRef,
  type AdapterOperationContext,
  type CapabilityManifest,
  type ConversationRef,
  type PreparedPublishTarget,
} from "../src/core/index.js";
import type { JsonValue } from "../src/core/types.js";
import { parseJson } from "../src/transport/json.js";
import { bluesky } from "../src/platforms/bluesky.js";
import { instagram } from "../src/platforms/instagram.js";
import { linkedin } from "../src/platforms/linkedin.js";
import { threads } from "../src/platforms/threads.js";
import { x } from "../src/platforms/x.js";
import { youtube } from "../src/platforms/youtube.js";

const context = (backend = "default"): AdapterOperationContext => ({
  backendInstance: backend,
  correlationId: "track6",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
});

interface Seen {
  readonly url: URL;
  readonly method: string;
  readonly body: string | undefined;
}

const recorder = (respond: (request: Seen) => Response) => {
  const seen: Seen[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = init?.body;

    const request: Seen = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      body: body === undefined || body === null ? undefined : String(body),
    };

    seen.push(request);

    return respond(request);
  };

  return { seen, fetch };
};

const jsonBody = (request: Seen | undefined): JsonValue => parseJson(request?.body ?? "null");

/** Fail the test instead of asserting a surface exists with `!`. */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined)
    throw new assert.AssertionError({ message: `${name} is not implemented` });

  return value;
}

const publishConstraints = (adapter: { readonly capabilities: CapabilityManifest }) =>
  adapter.capabilities.capabilities.find((entry) => entry.operation === "posts.publish")
    ?.constraints;

// Meta OAuthException code 190: the prose must never reach the SocialError.
const metaTokenError = () =>
  Response.json(
    {
      error: {
        message: "Error validating access token: private provider prose",
        type: "OAuthException",
        code: 190,
        fbtrace_id: "trace",
      },
    },
    { status: 400 },
  );

// A fixed message proves the provider prose never reaches the error.
const assertReconnect = {
  name: "SocialError",
  code: "reconnect_required",
  retryDisposition: { kind: "after-reconnect" },
  upstreamStatus: 400,
  message: "The Meta access token is invalid, expired, or revoked. Reconnect the account.",
};

it("classifies Meta Graph code 190 as reconnect_required on every Graph host", async () => {
  for (const flavor of ["instagram-login", "facebook-login"] as const) {
    const { seen, fetch } = recorder(metaTokenError);
    const adapter = instagram({ auth: { accessToken: "token", accountId: "ig1", flavor }, fetch });

    const account = connectedAccountRef({
      backend: "default",
      platform: "instagram",
      accountId: "ig1",
    });

    await assert.rejects(
      required(required(adapter.analytics, "analytics").getAccountMetrics, "getAccountMetrics")(
        account,
        context(),
      ),
      assertReconnect,
    );
    assert.equal(
      seen[0]?.url.hostname,
      flavor === "facebook-login" ? "graph.facebook.com" : "graph.instagram.com",
    );
  }

  const { seen, fetch } = recorder(metaTokenError);
  const adapter = threads({ auth: { userId: "u1", accessToken: "token" }, fetch });
  const account = connectedAccountRef({ backend: "default", platform: "threads", accountId: "u1" });

  await assert.rejects(
    required(adapter.accounts, "accounts").get(account, context()),
    assertReconnect,
  );
  assert.equal(seen[0]?.url.hostname, "graph.threads.net");
});

it("keeps other Meta 400 errors out of the reconnect classification", async () => {
  const { fetch } = recorder(() =>
    Response.json({ error: { code: 100, type: "OAuthException" } }, { status: 400 }),
  );

  const adapter = instagram({ auth: { accessToken: "token", accountId: "ig1" }, fetch });

  const account = connectedAccountRef({
    backend: "default",
    platform: "instagram",
    accountId: "ig1",
  });

  await assert.rejects(
    required(required(adapter.analytics, "analytics").getAccountMetrics, "getAccountMetrics")(
      account,
      context(),
    ),
    { name: "SocialError", code: "upstream_failure", upstreamStatus: 400 },
  );
});

it("Instagram code 190 during container creation is a reconnect, not an ambiguous outcome", async () => {
  const { fetch } = recorder(metaTokenError);
  const adapter = instagram({ auth: { accessToken: "token", accountId: "ig1" }, fetch });

  const account = connectedAccountRef({
    backend: "default",
    platform: "instagram",
    accountId: "ig1",
  });

  await assert.rejects(
    required(adapter.posts, "posts").publishTarget(
      {
        targetIndex: 0,
        targetKey: "instagram",
        account,
        content: {
          text: "caption",
          media: [
            {
              kind: "image",
              source: { kind: "https-url", url: "https://cdn.example/a.jpg" },
              mimeType: "image/jpeg",
            },
          ],
        },
      },
      context(),
    ),
    {
      name: "SocialError",
      code: "reconnect_required",
      retryDisposition: { kind: "after-reconnect" },
    },
  );
});

const igConversation: ConversationRef = {
  kind: "conversation",
  version: 1,
  backend: "default",
  platform: "instagram",
  accountId: "ig1",
  conversationId: "conversation-1",
};

it("Instagram requests participants, sender fields, and attachments, then normalizes them", async () => {
  const { seen, fetch } = recorder(({ url }) => {
    if (url.pathname.endsWith("/conversations"))
      return Response.json({
        data: [
          {
            id: "conversation-1",
            updated_time: "2026-10-11T12:00:00+0000",
            participants: {
              data: [
                { id: "ig1", username: "me" },
                { id: "c1", username: "cust" },
              ],
            },
          },
        ],
      });

    return Response.json({
      messages: {
        data: [
          {
            id: "m1",
            message: "Hello",
            created_time: "2026-10-11T12:01:00+0000",
            from: { id: "c1", username: "cust" },
            to: { data: [{ id: "ig1", username: "me" }] },
            attachments: { data: [{ image_data: { url: "https://cdn.example/x.jpg" } }] },
          },
        ],
      },
    });
  });

  const adapter = instagram({ auth: { accessToken: "token", accountId: "ig1" }, fetch });

  const account = connectedAccountRef({
    backend: "default",
    platform: "instagram",
    accountId: "ig1",
  });

  const conversations = await required(adapter.messages, "messages").listConversations(
    account,
    {},
    context(),
  );

  assert.equal(seen[0]?.url.searchParams.get("fields"), "id,participants,updated_time");
  assert.deepEqual(conversations.items[0]?.["participants"], {
    data: [
      { id: "ig1", username: "me" },
      { id: "c1", username: "cust" },
    ],
  });
  assert.equal(conversations.items[0]?.["updatedAt"], "2026-10-11T12:00:00+0000");

  const messages = await required(adapter.messages, "messages").listMessages(
    igConversation,
    { limit: 5 },
    context(),
  );

  assert.equal(
    seen[1]?.url.searchParams.get("fields"),
    "messages.limit(5){id,message,from,to,created_time,attachments}",
  );
  const [message] = messages.items;
  assert.equal(message?.["authorId"], "c1");
  assert.equal(message?.["authorHandle"], "cust");
  assert.equal(message?.["text"], "Hello");
  assert.equal(message?.["createdAt"], "2026-10-11T12:01:00+0000");
  assert.deepEqual(message?.["to"], { data: [{ id: "ig1", username: "me" }] });
  assert.ok(message?.["attachments"] !== undefined);

  await assert.rejects(
    required(adapter.messages, "messages").listMessages(
      igConversation,
      { cursor: "abc){id}" },
      context(),
    ),
    { code: "invalid_input" },
  );
  assert.equal(seen.length, 2);
});

it("Instagram comments retain the author record and parent ID", async () => {
  const { seen, fetch } = recorder(() =>
    Response.json({
      data: [
        {
          id: "c2",
          text: "Reply",
          timestamp: "2026-10-11T12:00:00+0000",
          username: "fan",
          from: { id: "u9", username: "fan" },
          parent_id: "c1",
          like_count: 3,
        },
      ],
    }),
  );

  const adapter = instagram({ auth: { accessToken: "token", accountId: "ig1" }, fetch });

  const post = platformPostRef({
    backend: "default",
    platform: "instagram",
    accountId: "ig1",
    postId: "media1",
  });

  const page = await required(adapter.comments, "comments").list(post, {}, context());
  assert.equal(
    seen[0]?.url.searchParams.get("fields"),
    "id,text,timestamp,username,from,parent_id,like_count",
  );
  assert.deepEqual(page.items[0]?.["from"], { id: "u9", username: "fan" });
  assert.equal(page.items[0]?.["authorId"], "u9");
  assert.equal(page.items[0]?.["parentId"], "c1");
});

it("Instagram messages.send resolves the single other participant, never the conversation ID", async () => {
  const { seen, fetch } = recorder(({ url, method }) =>
    method === "POST"
      ? Response.json({ recipient_id: "c1", message_id: "m2" })
      : url.searchParams.get("fields") === "participants"
        ? Response.json({
            participants: {
              data: [
                { id: "ig1", username: "me" },
                { id: "c1", username: "cust" },
              ],
            },
          })
        : Response.json({}),
  );

  const adapter = instagram({ auth: { accessToken: "token", accountId: "ig1" }, fetch });

  assert.equal(
    adapter.capabilities.capabilities.find((entry) => entry.operation === "messages.write")
      ?.availability,
    "available",
  );

  const result = await required(adapter.messages, "messages").send(
    igConversation,
    { text: "Thanks" },
    context(),
  );

  assert.deepEqual(result, { recipient_id: "c1", message_id: "m2" });
  assert.equal(seen[0]?.url.pathname, "/v25.0/conversation-1");
  assert.equal(seen[1]?.url.pathname, "/v25.0/ig1/messages");
  assert.deepEqual(jsonBody(seen[1]), { recipient: { id: "c1" }, message: { text: "Thanks" } });
});

it("Instagram messages.send rejects group, self-only, and unidentifiable conversations", async () => {
  const cases = [
    [{ id: "ig1" }, { id: "c1" }, { id: "c2" }],
    [{ id: "ig1" }],
    [{ id: "c1" }, { id: "c2" }],
    [{ id: "ig1" }, { username: "no-id" }],
  ];

  for (const participants of cases) {
    const { seen, fetch } = recorder(() => Response.json({ participants: { data: participants } }));
    const adapter = instagram({ auth: { accessToken: "token", accountId: "ig1" }, fetch });

    await assert.rejects(
      required(adapter.messages, "messages").send(igConversation, { text: "Hi" }, context()),
      {
        code: "invalid_input",
      },
    );
    assert.ok(seen.every((request) => request.method === "GET"));
  }

  // The conversation must belong to this authorization before any lookup.
  const { seen, fetch } = recorder(() => Response.json({}));
  const adapter = instagram({ auth: { accessToken: "token", accountId: "ig1" }, fetch });
  await assert.rejects(
    required(adapter.messages, "messages").send(
      { ...igConversation, accountId: "other" },
      { text: "Hi" },
      context(),
    ),
    { code: "unauthorized" },
  );
  assert.equal(seen.length, 0);
});

it("X bookmarks pass bounded maxResults and pagination_token", async () => {
  const { seen, fetch } = recorder(() =>
    Response.json({ data: [{ id: "1", text: "a" }], meta: { next_token: "tok2" } }),
  );

  const adapter = x({ auth: { userId: "u1", accessToken: "token" }, fetch });
  const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });

  const page = await required(adapter.native, "native").bookmarks({
    account,
    cursor: "tok1",
    maxResults: 50,
    context: context(),
  });

  assert.equal(seen[0]?.url.pathname, "/2/users/u1/bookmarks");
  assert.equal(seen[0]?.url.searchParams.get("max_results"), "50");
  assert.equal(seen[0]?.url.searchParams.get("pagination_token"), "tok1");
  assert.deepEqual(page["meta"], { next_token: "tok2" });

  for (const maxResults of [0, 101, 1.5])
    await assert.rejects(
      required(adapter.native, "native").bookmarks({ account, maxResults, context: context() }),
      {
        code: "invalid_input",
      },
    );
  await assert.rejects(
    required(adapter.native, "native").bookmarks({ account, cursor: "", context: context() }),
    {
      code: "invalid_input",
    },
  );
  assert.equal(seen.length, 1);
});

it("X search projections keep edit_history_tweet_ids", async () => {
  const { fetch } = recorder(() =>
    Response.json({
      data: [{ id: "2", text: "edited", edit_history_tweet_ids: ["1", "2"], author_id: "u2" }],
    }),
  );

  const adapter = x({ auth: { userId: "u1", accessToken: "token" }, fetch });
  const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });

  const page = await required(adapter.search, "search").posts(
    account,
    { query: "edited" },
    context(),
  );

  assert.deepEqual(page.items[0]?.["edit_history_tweet_ids"], ["1", "2"]);
});

const xImageTarget = (altText: string): PreparedPublishTarget => ({
  targetIndex: 0,
  targetKey: "x",
  account: connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" }),
  content: {
    text: "Image",
    media: [
      {
        kind: "image",
        mimeType: "image/png",
        altText,
        source: {
          kind: "blob",
          blob: new Blob([new Uint8Array(10)], { type: "image/png" }),
          fingerprint: "img",
        },
      },
    ],
  },
});

it("X attaches image alt text through media metadata before creating the post", async () => {
  const { seen, fetch } = recorder(({ url }) =>
    url.pathname === "/2/media/upload"
      ? Response.json({ data: { id: "media1" } })
      : url.pathname === "/2/media/metadata"
        ? Response.json({ data: { id: "media1" } })
        : Response.json({ data: { id: "post1", text: "Image" } }),
  );

  const adapter = x({ auth: { userId: "u1", accessToken: "token" }, fetch });
  const target = xImageTarget("A red square");

  assert.deepEqual(
    required(required(adapter.posts, "posts").prepareTarget, "prepareTarget")(target),
    [],
  );
  const outcome = await required(adapter.posts, "posts").publishTarget(target, context());

  assert.equal(outcome.state, "published");
  assert.deepEqual(
    seen.map((request) => request.url.pathname),
    ["/2/media/upload", "/2/media/metadata", "/2/tweets"],
  );
  assert.deepEqual(jsonBody(seen[1]), {
    id: "media1",
    metadata: { alt_text: { text: "A red square" } },
  });
});

it("X stops before post creation when alt text metadata fails, and validates its length", async () => {
  const { seen, fetch } = recorder(({ url }) =>
    url.pathname === "/2/media/upload"
      ? Response.json({ data: { id: "media1" } })
      : url.pathname === "/2/media/metadata"
        ? Response.json({ detail: "private detail" }, { status: 400 })
        : Response.json({ data: { id: "post1" } }),
  );

  const adapter = x({ auth: { userId: "u1", accessToken: "token" }, fetch });

  await assert.rejects(
    required(adapter.posts, "posts").publishTarget(xImageTarget("alt"), context()),
    {
      name: "SocialError",
      code: "upstream_failure",
      operation: "media.metadata",
      message:
        "X did not confirm the image alt text, so no post was created. The uploaded media was not attached to a post.",
    },
  );
  assert.ok(!seen.some((request) => request.url.pathname === "/2/tweets"));

  const issues = required(
    required(adapter.posts, "posts").prepareTarget,
    "prepareTarget",
  )(xImageTarget("a".repeat(1001)));

  assert.ok(issues.some((issue) => issue.code === "x.alt_text"));
});

it("Threads sends content.link.url as link_attachment on a text container", async () => {
  const { seen, fetch } = recorder(({ url, method }) =>
    method === "POST" && url.pathname.endsWith("/threads")
      ? Response.json({ id: "container1" })
      : method === "POST"
        ? Response.json({ id: "post1" })
        : Response.json({ id: "container1", status: "FINISHED" }),
  );

  const adapter = threads({ auth: { userId: "u1", accessToken: "token" }, fetch });
  const account = connectedAccountRef({ backend: "default", platform: "threads", accountId: "u1" });

  const target: PreparedPublishTarget = {
    targetIndex: 0,
    targetKey: "threads",
    account,
    content: { text: "Read this", link: { url: "https://example.com/article" } },
  };

  assert.deepEqual(
    required(required(adapter.posts, "posts").prepareTarget, "prepareTarget")(target),
    [],
  );
  const outcome = await required(adapter.posts, "posts").publishTarget(target, context());

  assert.equal(outcome.state, "published");
  const create = seen.find((request) => request.url.pathname.endsWith("/u1/threads"));
  assert.equal(create?.url.searchParams.get("media_type"), "TEXT");
  assert.equal(create?.url.searchParams.get("link_attachment"), "https://example.com/article");

  const withMedia = required(
    required(adapter.posts, "posts").prepareTarget,
    "prepareTarget",
  )({
    ...target,
    content: {
      ...target.content,
      media: [
        {
          kind: "image",
          mimeType: "image/png",
          source: { kind: "https-url", url: "https://cdn.example/a.png" },
        },
      ],
    },
  });

  assert.ok(withMedia.some((issue) => issue.code === "link.media_conflict"));

  const insecure = required(
    required(adapter.posts, "posts").prepareTarget,
    "prepareTarget",
  )({
    ...target,
    content: { text: "x", link: { url: "http://example.com" } },
  });

  assert.ok(insecure.some((issue) => issue.code === "link.url_invalid"));
});

it("YouTube sends options.categoryId in the upload snippet and validates it", async () => {
  const { seen, fetch } = recorder(({ method }) =>
    method === "POST"
      ? new Response(null, {
          headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=s" },
        })
      : Response.json({ id: "video1", status: { uploadStatus: "uploaded" } }),
  );

  const adapter = youtube({ auth: { accessToken: "token", channelId: "channel1" }, fetch });

  const account = connectedAccountRef({
    backend: "default",
    platform: "youtube",
    accountId: "channel1",
  });

  const target = (categoryId: string): PreparedPublishTarget => ({
    targetIndex: 0,
    targetKey: "youtube",
    account,
    options: { title: "Example", visibility: "private", madeForKids: false, categoryId },
    content: {
      text: "description",
      media: [
        {
          kind: "video",
          mimeType: "video/mp4",
          source: { kind: "blob", blob: new Blob([new Uint8Array(10)]), fingerprint: "v" },
        },
      ],
    },
  });

  assert.deepEqual(
    required(required(adapter.posts, "posts").prepareTarget, "prepareTarget")(target("22")),
    [],
  );
  assert.ok(
    required(
      required(adapter.posts, "posts").prepareTarget,
      "prepareTarget",
    )(target("People")).some((issue) => issue.code === "youtube.category"),
  );

  await required(adapter.posts, "posts").publishTarget(target("22"), context());
  assert.deepEqual(jsonBody(seen[0]), {
    snippet: { title: "Example", description: "description", categoryId: "22" },
    status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
  });
});

const linkedInPost = platformPostRef({
  backend: "default",
  platform: "linkedin",
  accountId: "urn:li:person:member1",
  postId: "urn:li:share:1",
});

const linkedInAdapter = (comments: () => Response) => {
  const recorded = recorder(({ url }) =>
    url.pathname.startsWith("/rest/posts/")
      ? Response.json({ id: "urn:li:share:1", author: "urn:li:person:member1" })
      : comments(),
  );

  return {
    ...recorded,
    adapter: linkedin({
      auth: { accessToken: "token", author: "urn:li:person:member1" },
      apiVersion: "202609",
      fetch: recorded.fetch,
    }),
  };
};

it("LinkedIn comments stop on an empty page instead of repeating the cursor", async () => {
  const { adapter } = linkedInAdapter(() =>
    Response.json({ elements: [], paging: { start: 10, count: 10, total: 25 } }),
  );

  const page = await required(adapter.comments, "comments").list(
    linkedInPost,
    { cursor: "10" },
    context(),
  );

  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, undefined);
});

it("LinkedIn comments reject malformed offsets before any request", async () => {
  const { seen, adapter } = linkedInAdapter(() => Response.json({ elements: [] }));

  for (const cursor of ["", "1e2", "0x10", " 5", "-1", "01", "1.5"])
    await assert.rejects(
      required(adapter.comments, "comments").list(linkedInPost, { cursor }, context()),
      {
        code: "invalid_input",
      },
    );
  assert.equal(seen.length, 0);
});

it("LinkedIn comments retain commentUrn, actor, created, and advance the offset", async () => {
  const { seen, adapter } = linkedInAdapter(() =>
    Response.json({
      elements: [
        {
          id: "7001",
          commentUrn: "urn:li:comment:(urn:li:activity:1,7001)",
          actor: "urn:li:person:fan",
          object: "urn:li:activity:1",
          message: { text: "Nice" },
          created: { actor: "urn:li:person:fan", time: 1_760_000_000_000 },
          parentComment: "urn:li:comment:(urn:li:activity:1,7000)",
        },
      ],
      paging: { start: 0, count: 1, total: 3 },
    }),
  );

  const page = await required(adapter.comments, "comments").list(
    linkedInPost,
    { limit: 1 },
    context(),
  );

  const [comment] = page.items;

  assert.equal(comment?.["commentUrn"], "urn:li:comment:(urn:li:activity:1,7001)");
  assert.deepEqual(comment?.["created"], { actor: "urn:li:person:fan", time: 1_760_000_000_000 });
  assert.equal(comment?.["authorId"], "urn:li:person:fan");
  assert.equal(comment?.["text"], "Nice");
  assert.equal(comment?.["createdAt"], new Date(1_760_000_000_000).toISOString());
  assert.equal(page.nextCursor, "1");
  assert.ok(seen.at(-1)?.url.search.includes("start=0&count=1"));
});

it("adds canonicalName without changing provider metric fields", async () => {
  const { adapter } = linkedInAdapter(() =>
    Response.json({
      target: "urn:li:share:1",
      likesSummary: { totalLikes: 4 },
      commentsSummary: { totalFirstLevelComments: 2 },
    }),
  );

  const metrics = await required(adapter.analytics, "analytics").getPostMetrics(
    linkedInPost,
    context(),
  );

  assert.deepEqual(
    metrics.map(({ name, canonicalName, unit, period, source }) => ({
      name,
      canonicalName,
      unit,
      period,
      source,
    })),
    [
      {
        name: "likes",
        canonicalName: "likes",
        unit: "count",
        period: "lifetime",
        source: "linkedin:202609:socialActions",
      },
      {
        name: "comments",
        canonicalName: "comments",
        unit: "count",
        period: "lifetime",
        source: "linkedin:202609:socialActions",
      },
    ],
  );

  const { fetch } = recorder(() =>
    Response.json({ user_id: "ig1", followers_count: 10, media_count: 3 }),
  );

  const ig = instagram({ auth: { accessToken: "token", accountId: "ig1" }, fetch });

  const account = connectedAccountRef({
    backend: "default",
    platform: "instagram",
    accountId: "ig1",
  });

  const igMetrics = await required(
    required(ig.analytics, "analytics").getAccountMetrics,
    "getAccountMetrics",
  )(account, context());

  const followers = igMetrics.find((metric) => metric.name === "followers_count");
  assert.equal(followers?.canonicalName, "followers");
  assert.equal(followers?.value, 10);
});

it("declares machine-readable publish media constraints that match prepareTarget", () => {
  const fetch: typeof globalThis.fetch = async () => Response.json({});

  assert.deepEqual(
    publishConstraints(instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch })),
    {
      mediaSources: ["https-url"],
      maxItems: 10,
      allowedMimeTypes: ["image/jpeg", "video/mp4", "video/quicktime"],
    },
  );
  assert.deepEqual(
    publishConstraints(threads({ auth: { userId: "u1", accessToken: "t" }, fetch })),
    {
      mediaSources: ["https-url"],
      maxItems: 20,
      allowedMimeTypes: ["image/jpeg", "image/png", "video/mp4", "video/quicktime"],
    },
  );
  assert.equal(
    publishConstraints(x({ auth: { userId: "u1", accessToken: "t" }, fetch }))?.maxItems,
    4,
  );
  assert.deepEqual(
    publishConstraints(youtube({ auth: { accessToken: "t", channelId: "c1" }, fetch })),
    { mediaSources: ["blob", "stream"], maxItems: 1, allowedMimeTypes: ["video/*"] },
  );
  assert.equal(
    publishConstraints(
      linkedin({
        auth: { accessToken: "t", author: "urn:li:person:m" },
        apiVersion: "202609",
        fetch,
      }),
    )?.maxItems,
    20,
  );
  assert.equal(
    publishConstraints(
      bluesky({
        auth: { did: "did:plc:abc", accessJwt: "t", service: "https://pds.example" },
        fetch,
      }),
    )?.maxItems,
    4,
  );
});
