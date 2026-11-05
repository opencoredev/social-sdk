import { test } from "node:test";
import assert from "node:assert/strict";
import { threads, MemoryThreadsWorkflowStore } from "../src/platforms/threads.js";
import {
  connectedAccountRef,
  type AdapterOperationContext,
  type JsonObject,
  type PreparedPublishTarget,
  type ThreadsPublishOptions,
} from "../src/core/index.js";

const account = connectedAccountRef({ backend: "default", platform: "threads", accountId: "u1" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "fixture",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

interface Seen {
  readonly url: URL;
  readonly method: string;
}

function publishing(publishBody: Record<string, string> = { id: "native-1" }) {
  const seen: Seen[] = [];

  const store = new MemoryThreadsWorkflowStore();

  const adapter = threads({
    auth: { userId: "u1", accessToken: "fixture" },
    workflowStore: store,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      seen.push({ url, method });

      if (method === "POST" && url.pathname.endsWith("/u1/threads"))
        return Response.json({ id: `container-${seen.length}` });

      if (method === "POST" && url.pathname.endsWith("/threads_publish"))
        return Response.json(publishBody);

      return Response.json({ id: "container", status: "FINISHED" });
    },
  });

  const posts = adapter.posts;
  assert.ok(posts?.prepareTarget);
  const prepare = posts.prepareTarget.bind(posts);

  const parentCreate = () =>
    seen.filter(
      (request) =>
        request.method === "POST" &&
        request.url.pathname.endsWith("/u1/threads") &&
        request.url.searchParams.get("is_carousel_item") !== "true",
    );

  return { adapter, posts, prepare, seen, store, parentCreate };
}

function target(
  content: PreparedPublishTarget["content"],
  options: ThreadsPublishOptions,
): PreparedPublishTarget {
  return { targetIndex: 0, targetKey: "threads", account, content, options };
}

const image = {
  kind: "image" as const,
  source: { kind: "https-url" as const, url: "https://cdn.example.test/a.jpg" },
};

test("Threads text post sends every documented container option on the wire", async () => {
  const { posts, prepare, parentCreate } = publishing();

  const options: ThreadsPublishOptions = {
    replyControl: "parentPostAuthorOnly",
    enableReplyApprovals: true,
    topicTag: "Open Source",
    poll: { options: ["Yes", "No", "Maybe"] },
    gif: { gifId: "3o85xEFRBYvAnamJnG", provider: "GIPHY" },
    isMadeWithAi: true,
    spoilers: [
      { offset: 0, length: 5 },
      { offset: 6, length: 3 },
    ],
    locationId: "12345",
    allowlistedCountryCodes: ["US", "CA"],
    shareToInstagramStory: "dark",
  };

  const post = target({ text: "Hello big world" }, options);

  assert.deepEqual(prepare(post), []);
  const outcome = await posts.publishTarget(post, context);
  assert.equal(outcome.state, "published");

  const [create] = parentCreate();
  const params = create?.url.searchParams;
  assert.equal(params?.get("media_type"), "TEXT");
  assert.equal(params?.get("reply_control"), "parent_post_author_only");
  assert.equal(params?.get("enable_reply_approvals"), "true");
  assert.equal(params?.get("topic_tag"), "Open Source");
  assert.deepEqual(JSON.parse(params?.get("poll_attachment") ?? ""), {
    option_a: "Yes",
    option_b: "No",
    option_c: "Maybe",
  });
  assert.deepEqual(JSON.parse(params?.get("gif_attachment") ?? ""), {
    gif_id: "3o85xEFRBYvAnamJnG",
    provider: "GIPHY",
  });
  assert.equal(params?.get("is_made_with_ai"), "true");
  assert.deepEqual(JSON.parse(params?.get("text_entities") ?? ""), [
    { entity_type: "SPOILER", offset: 0, length: 5 },
    { entity_type: "SPOILER", offset: 6, length: 3 },
  ]);
  assert.equal(params?.get("location_id"), "12345");
  assert.equal(params?.get("allowlisted_country_codes"), "US,CA");
  assert.equal(params?.get("crossreshare_to_ig_dark_mode"), "true");
  assert.equal(params?.get("crossreshare_to_ig"), null);
});

test("Threads maps followersOnly reply_control and light Instagram Story cross-share", async () => {
  const { posts, parentCreate } = publishing();

  await posts.publishTarget(
    target({ text: "hi" }, { replyControl: "followersOnly", shareToInstagramStory: "light" }),
    context,
  );

  const params = parentCreate()[0]?.url.searchParams;
  assert.equal(params?.get("reply_control"), "followers_only");
  assert.equal(params?.get("crossreshare_to_ig"), "true");
  assert.equal(params?.get("crossreshare_to_ig_dark_mode"), null);
});

test("Threads keeps crossreshare_to_ig_status from the publish response on the workflow", async () => {
  const { posts, store } = publishing({ id: "native-1", crossreshare_to_ig_status: "FAILED" });

  const outcome = await posts.publishTarget(
    target({ text: "hi" }, { shareToInstagramStory: "light" }),
    context,
  );

  assert.equal(outcome.state, "published");
  const workflow = await store.get(outcome.delivery?.deliveryId ?? "");
  assert.equal(workflow?.instagramStoryStatus, "FAILED");
});

test("Threads reports a failed Instagram Story cross-share as a warning on every published outcome", async () => {
  const { adapter, posts } = publishing({ id: "native-1", crossreshare_to_ig_status: "FAILED" });

  const outcome = await posts.publishTarget(
    target({ text: "hi" }, { shareToInstagramStory: "light" }),
    context,
  );

  const delivery = outcome.delivery;
  assert.ok(delivery);
  const resumed = await adapter.native?.resumePublication(account, delivery.deliveryId, context);
  const observed = await posts.getDelivery?.(delivery, context);

  for (const result of [outcome, resumed, observed]) {
    assert.equal(result?.state, "published");
    assert.ok(result?.state === "published");
    assert.deepEqual(
      result.issues?.map((issue) => [issue.path, issue.code, issue.severity]),
      [["crossreshare_to_ig_status", "FAILED", "warning"]],
    );
  }
});

test("Threads adds no issues when the Instagram Story cross-share succeeds", async () => {
  const { posts } = publishing({ id: "native-1", crossreshare_to_ig_status: "SUCCESS" });

  const outcome = await posts.publishTarget(
    target({ text: "hi" }, { shareToInstagramStory: "light" }),
    context,
  );

  assert.ok(outcome.state === "published");
  assert.equal(outcome.issues, undefined);
});

test("Threads sets is_spoiler_media and is_made_with_ai on the carousel parent only", async () => {
  const { posts, seen, parentCreate } = publishing();

  await posts.publishTarget(
    target(
      { text: "gallery", media: [image, { ...image, source: { ...image.source } }] },
      { isSpoilerMedia: true, isMadeWithAi: true },
    ),
    context,
  );

  const children = seen.filter(
    (request) => request.url.searchParams.get("is_carousel_item") === "true",
  );

  assert.equal(children.length, 2);

  for (const child of children) {
    assert.equal(child.url.searchParams.get("is_spoiler_media"), null);
    assert.equal(child.url.searchParams.get("is_made_with_ai"), null);
  }

  const parent = parentCreate()[0]?.url.searchParams;
  assert.equal(parent?.get("media_type"), "CAROUSEL");
  assert.equal(parent?.get("is_spoiler_media"), "true");
  assert.equal(parent?.get("is_made_with_ai"), "true");
});

test("Threads sends quote_post_id on an image container", async () => {
  const { posts, parentCreate } = publishing();

  await posts.publishTarget(
    target({ text: "quoting", media: [image] }, { quotePostId: "17890000000000001" }),
    context,
  );

  const params = parentCreate()[0]?.url.searchParams;
  assert.equal(params?.get("media_type"), "IMAGE");
  assert.equal(params?.get("quote_post_id"), "17890000000000001");
});

test("Threads sends text_attachment with link and sorted styling ranges", async () => {
  const { posts, prepare, parentCreate } = publishing();

  const post = target(
    { text: "Long read" },
    {
      textAttachment: {
        plaintext: "Lengthy plain text for the attachment.",
        linkAttachmentUrl: "https://example.com/story",
        styling: [
          { offset: 8, length: 5, styles: ["highlight"] },
          { offset: 0, length: 7, styles: ["bold", "italic"] },
        ],
      },
    },
  );

  assert.deepEqual(prepare(post), []);
  await posts.publishTarget(post, context);

  assert.deepEqual(JSON.parse(parentCreate()[0]?.url.searchParams.get("text_attachment") ?? ""), {
    plaintext: "Lengthy plain text for the attachment.",
    link_attachment_url: "https://example.com/story",
    text_with_styling_info: [
      { offset: 0, length: 7, styling_info: ["bold", "italic"] },
      { offset: 8, length: 5, styling_info: ["highlight"] },
    ],
  });
});

test("Threads sends is_ghost_post with text spoilers and rejects other ghost features", async () => {
  const { posts, prepare, parentCreate } = publishing();

  const ghost = target(
    { text: "gone tomorrow" },
    { isGhostPost: true, spoilers: [{ offset: 0, length: 4 }] },
  );

  assert.deepEqual(prepare(ghost), []);
  await posts.publishTarget(ghost, context);
  assert.equal(parentCreate()[0]?.url.searchParams.get("is_ghost_post"), "true");

  const codes = (options: ThreadsPublishOptions, content: PreparedPublishTarget["content"]) =>
    prepare(target(content, options)).map((issue) => issue.code);

  assert.deepEqual(codes({ isGhostPost: true, topicTag: "News" }, { text: "x" }), [
    "options.is_ghost_post",
  ]);
  assert.deepEqual(codes({ isGhostPost: true }, { text: "x", media: [image] }), [
    "options.is_ghost_post",
  ]);
  assert.deepEqual(
    prepare({
      ...target({ text: "x" }, { isGhostPost: true }),
      replyTo: {
        kind: "platform-post",
        version: 1,
        backend: "default",
        platform: "threads",
        accountId: "u1",
        postId: "1",
      },
    }).map((issue) => issue.code),
    ["options.is_ghost_post"],
  );
});

test("Threads prepareTarget rejects options that Threads documents as invalid", () => {
  const { prepare } = publishing();

  const codes = (options: JsonObject, content: PreparedPublishTarget["content"] = { text: "hi" }) =>
    prepare({ targetIndex: 0, targetKey: "t", account, content, options }).map(
      (issue) => issue.code,
    );

  assert.deepEqual(codes({ replyControl: "nobody" }), ["options.reply_control"]);
  assert.deepEqual(codes({ enableReplyApprovals: "yes" }), ["options.enable_reply_approvals"]);
  assert.deepEqual(codes({ topicTag: "a.b" }), ["options.topic_tag"]);
  assert.deepEqual(codes({ topicTag: "x".repeat(51) }), ["options.topic_tag"]);
  assert.deepEqual(codes({ topicTag: "" }), ["options.topic_tag"]);
  assert.deepEqual(codes({ quotePostId: "abc" }), ["options.quote_post_id"]);
  assert.deepEqual(codes({ poll: { options: ["only one"] } }), ["options.poll_attachment"]);
  assert.deepEqual(codes({ poll: { options: ["a", "b", "c", "d", "e"] } }), [
    "options.poll_attachment",
  ]);
  assert.deepEqual(codes({ poll: { options: ["a", "x".repeat(26)] } }), [
    "options.poll_attachment",
  ]);
  assert.deepEqual(codes({ poll: { options: ["a", "b"] } }, { text: "hi", media: [image] }), [
    "options.poll_attachment",
  ]);
  assert.deepEqual(codes({ gif: { gifId: "g1", provider: "TENOR" } }), ["options.gif_attachment"]);
  assert.deepEqual(codes({ gif: { gifId: "g1", provider: "GIPHY" } }, { media: [image] }), [
    "options.gif_attachment",
  ]);
  assert.deepEqual(codes({ isSpoilerMedia: true }), ["options.is_spoiler_media"]);
  assert.deepEqual(codes({ spoilers: [{ offset: 0, length: 3 }] }), ["options.text_entities"]);
  assert.deepEqual(
    codes({ spoilers: Array.from({ length: 11 }, () => ({ offset: 0, length: 1 })) }),
    ["options.text_entities"],
  );
  assert.deepEqual(codes({ textAttachment: { plaintext: "x".repeat(10_001) } }), [
    "options.text_attachment",
  ]);
  assert.deepEqual(
    codes({ textAttachment: { plaintext: "x", linkAttachmentUrl: "http://example.com" } }),
    ["options.text_attachment"],
  );
  assert.deepEqual(
    codes({
      textAttachment: {
        plaintext: "abcdefgh",
        styling: [
          { offset: 0, length: 4, styles: ["bold"] },
          { offset: 2, length: 4, styles: ["italic"] },
        ],
      },
    }),
    ["options.text_attachment"],
  );
  assert.deepEqual(
    codes({
      textAttachment: { plaintext: "abc", styling: [{ offset: 0, length: 2, styles: [] }] },
    }),
    ["options.text_attachment"],
  );
  assert.deepEqual(codes({ textAttachment: { plaintext: "x" }, poll: { options: ["a", "b"] } }), [
    "options.text_attachment",
  ]);
  assert.deepEqual(
    codes(
      { textAttachment: { plaintext: "x", linkAttachmentUrl: "https://example.com/b" } },
      { text: "hi", link: { url: "https://example.com/a" } },
    ),
    ["options.text_attachment"],
  );
  assert.deepEqual(codes({ locationId: "Menlo Park" }), ["options.location_id"]);
  assert.deepEqual(codes({ allowlistedCountryCodes: ["us"] }), [
    "options.allowlisted_country_codes",
  ]);
  assert.deepEqual(codes({ allowlistedCountryCodes: [] }), ["options.allowlisted_country_codes"]);
  assert.deepEqual(codes({ shareToInstagramStory: true }), ["options.crossreshare_to_ig"]);
  assert.deepEqual(codes({ somethingElse: true }), ["options.unmapped"]);
});

test("Threads rejects more than five unique links before creating a container [feature:threads.publish.linkLimit]", () => {
  const { prepare } = publishing();

  const codes = (content: PreparedPublishTarget["content"], options: ThreadsPublishOptions = {}) =>
    prepare(target(content, options)).map((issue) => issue.code);

  // Repeated URLs count once, and a link attachment equal to a text URL is not counted twice.
  assert.deepEqual(
    codes({
      text: "a.example.com https://b.example.com www.c.example.com https://b.example.com/ www.d.example.com www.e.example.com",
      link: { url: "https://b.example.com" },
    }),
    [],
  );
  assert.deepEqual(
    codes(
      { text: "www.a.com www.b.com www.c.com www.d.com www.e.com" },
      { textAttachment: { plaintext: "more", linkAttachmentUrl: "https://www.f.com" } },
    ),
    ["link.limit_exceeded"],
  );
  assert.deepEqual(
    codes({
      text: "www.a.com www.b.com www.c.com www.d.com www.e.com",
      link: { url: "https://www.f.com" },
    }),
    ["link.limit_exceeded"],
  );
});

test("Threads autoPublishText sends auto_publish_text, skips threads_publish and stays unknown [feature:threads.publish.autoPublishText]", async () => {
  const { posts, prepare, seen, parentCreate } = publishing();

  const post = target({ text: "published on create" }, { autoPublishText: true });

  assert.deepEqual(prepare(post), []);

  const outcome = await posts.publishTarget(post, context);

  assert.equal(parentCreate()[0]?.url.searchParams.get("auto_publish_text"), "true");
  assert.equal(
    seen.some((request) => request.url.pathname.endsWith("/threads_publish")),
    false,
  );
  assert.equal(outcome.state, "unknown");
  assert.ok(outcome.state === "unknown" && outcome.reason === "ambiguous-submission");
  assert.equal(outcome.backendState, "AUTO_PUBLISHED");

  const delivery = outcome.delivery;
  assert.ok(delivery);
  const again = await posts.getDelivery?.(delivery, context);
  assert.equal(again?.state, "unknown");
  assert.equal(
    seen.filter((request) => request.method === "POST").length,
    1,
    "a status read must not replay the create call",
  );

  assert.deepEqual(
    prepare(target({ text: "x", media: [image] }, { autoPublishText: true })).map(
      (issue) => issue.code,
    ),
    ["options.auto_publish_text"],
  );
});
