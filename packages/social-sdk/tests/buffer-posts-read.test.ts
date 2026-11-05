import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, createSocial, type Platform } from "../src/index.js";
import { buffer } from "../src/cloud/buffer.js";
import { SocialError } from "../src/core/errors.js";
import type {
  AdapterOperationContext,
  DeliveryRef,
  JsonObject,
  JsonValue,
  MediaAttachment,
  PublishContent,
} from "../src/core/types.js";
import { isJsonValue } from "../src/transport/json.js";
import { object, string } from "../src/transport/validation.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-11-04T12:00:00.000Z");

const future = "2026-11-05T15:00:00.000Z";

const services = new Map([
  ["x", "twitter"],
  ["instagram", "instagram"],
  ["linkedin", "linkedin"],
  ["substack", "substack"],
]);

const channelId = (platform: Platform) => `channel_${platform}`;

const ref = (platform: Platform) =>
  connectedAccountRef({ backend: "default", platform, accountId: channelId(platform) });

const image = (name: string, fields: Partial<MediaAttachment> = {}): MediaAttachment => ({
  kind: "image",
  source: { kind: "https-url", url: `https://cdn.example.test/${name}.gif` },
  mimeType: "image/gif",
  ...fields,
});

const post = (platform: Platform, fields: JsonObject = {}): JsonObject => ({
  id: "post_example",
  text: "Hello",
  channelId: channelId(platform),
  channelService: string(services.get(platform)),
  dueAt: future,
  sentAt: null,
  status: "scheduled",
  shareMode: "customScheduled",
  schedulingType: "automatic",
  externalLink: null,
  ...fields,
});

interface Operation {
  readonly query: string;
  readonly variables: JsonObject;
}

/** A fake Buffer GraphQL API with one channel per service, plus `answer` for other operations. */
function fakeBuffer(answer: (operation: Operation) => JsonValue) {
  const operations: Operation[] = [];

  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const parsed: unknown = JSON.parse(String(init?.body));

    assert.ok(isJsonValue(parsed));

    const body = object(parsed);
    const operation = { query: string(body["query"]), variables: object(body["variables"] ?? {}) };

    operations.push(operation);

    if (operation.query.includes("query Channels"))
      return Response.json({
        data: {
          channels: Array.from(services).map(([platform, service]) => ({
            id: `channel_${platform}`,
            name: platform,
            displayName: platform,
            service,
            organizationId: "org_example",
          })),
        },
      });

    return Response.json({ data: answer(operation) });
  };

  return {
    operations,
    adapter: buffer({ apiKey: "fixture-key", organizationId: "org_example", clock, fetch }),
  };
}

/** Prepare and publish one target, returning the issues and the `createPost` input. */
async function publish(platform: Platform, content: PublishContent, options: JsonObject = {}) {
  const { adapter, operations } = fakeBuffer((operation) =>
    operation.query.includes("createPost") ? { createPost: { post: post(platform) } } : null,
  );

  const social = createSocial({ backend: adapter, clock });
  const request = { targets: [{ account: ref(platform), options }], content };
  const prepared = social.posts.prepare(request);
  const result = prepared.ok ? await social.posts.publish(request) : undefined;
  const create = operations.find((operation) => operation.query.includes("createPost"));

  return {
    issues: prepared.issues.map((issue) => issue.code),
    outcome: result?.outcomes[0],
    input: create === undefined ? undefined : object(create.variables["input"]),
  };
}

const delivery = (platform: Platform): DeliveryRef => ({
  kind: "delivery",
  version: 1,
  backend: "default",
  platform,
  accountId: channelId(platform),
  deliveryId: "post_example",
});

it("Buffer lists posts with status, date, dueAtPresence, postTypes, tag filters and sort [feature:buffer.read.posts_filters]", async () => {
  const { adapter, operations } = fakeBuffer(() => ({
    posts: {
      edges: [
        { node: post("instagram", { metadata: { type: "reel" } }) },
        { node: post("x", { id: "other_channel" }) },
      ],
      pageInfo: { hasNextPage: true, endCursor: "cursor_2" },
    },
  }));

  const page = await adapter.native.listPosts(
    {
      accounts: [ref("instagram")],
      status: ["scheduled", "draft"],
      dueAt: { start: "2026-11-01T00:00:00Z", end: "2026-11-30T23:59:59Z" },
      dueAtPresence: "present",
      createdAt: { start: "2026-10-01T00:00:00Z" },
      postTypes: ["reel", "story"],
      tags: { in: ["tag_launch"], isEmpty: true },
      sort: [{ field: "dueAt", direction: "asc" }],
      limit: 10,
    },
    context,
  );

  const query = operations.find((operation) => operation.query.includes("query Posts"));

  assert.deepEqual(query?.variables, {
    first: 10,
    input: {
      organizationId: "org_example",
      filter: {
        channelIds: ["channel_instagram"],
        status: ["scheduled", "draft"],
        dueAt: { start: "2026-11-01T00:00:00.000Z", end: "2026-11-30T23:59:59.000Z" },
        dueAtPresence: "present",
        createdAt: { start: "2026-10-01T00:00:00.000Z" },
        postTypes: ["reel", "story"],
        tags: { in: ["tag_launch"], isEmpty: true },
      },
      sort: [{ field: "dueAt", direction: "asc" }],
    },
  });
  assert.deepEqual(
    page.items.map((item) => [item["id"], item["postType"]]),
    [["post_example", "reel"]],
  );
  assert.equal(page.nextCursor, "cursor_2");

  await assert.rejects(
    adapter.native.listPosts(
      { accounts: [ref("instagram")], dueAtPresence: "absent", dueAt: { start: future } },
      context,
    ),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
  await assert.rejects(
    adapter.native.listPosts({ accounts: [ref("instagram")], postTypes: ["tweet"] }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Buffer returns the post error message, rawError and supportUrl as read data, never in the outcome message [feature:buffer.read.post_error]", async () => {
  const failed = post("linkedin", {
    status: "error",
    error: {
      message: "LinkedIn rejected the image size.",
      rawError: "MEDIA_ASSET_PROCESSING_FAILED",
      supportUrl: "https://support.buffer.com/article/linkedin-errors",
    },
  });

  const { adapter, operations } = fakeBuffer(() => ({ post: failed }));
  const outcome = await adapter.posts.getDelivery(delivery("linkedin"), context);

  assert.equal(outcome.state, "failed");
  // The outcome message is fixed: Buffer's error prose and links stay out of failure text.
  assert.equal(
    outcome.state === "failed" ? outcome.message : undefined,
    "Buffer reports that this post failed. Inspect the channel connection and the post in Buffer.",
  );
  assert.doesNotMatch(
    JSON.stringify(outcome),
    /LinkedIn rejected|support\.buffer\.com|MEDIA_ASSET/,
  );
  assert.match(string(operations.at(-1)?.query), /error \{\s+message\s+rawError\s+supportUrl/);

  const read = await adapter.posts.get(
    { ...delivery("linkedin"), kind: "platform-post", postId: "post_example" },
    context,
  );

  assert.deepEqual(read["error"], {
    message: "LinkedIn rejected the image size.",
    supportUrl: "https://support.buffer.com/article/linkedin-errors",
    rawError: "MEDIA_ASSET_PROCESSING_FAILED",
  });
});

it("Buffer reads back assets, tags, author, allowedActions and notificationStatus [feature:buffer.read.post_content_fields]", async () => {
  const stored = post("instagram", {
    status: "sent",
    createdAt: "2026-11-01T09:00:00.000Z",
    ideaId: "idea_1",
    via: "api",
    notificationStatus: "markedAsPublished",
    allowedActions: ["viewPost", "duplicatePost"],
    tags: [{ id: "tag_launch", name: "Launch", color: "#F523F1" }],
    assets: [
      {
        type: "image",
        source: "https://cdn.buffer.com/a.gif",
        thumbnail: "https://cdn.buffer.com/a-thumb.jpg",
        mimeType: "image/gif",
        image: { altText: "A chart", animatedThumbnail: "https://cdn.buffer.com/a-anim.gif" },
      },
    ],
    author: { id: "acct_1", name: "Sam" },
    metadata: { type: "post" },
  });

  const { adapter, operations } = fakeBuffer(() => ({ post: stored }));

  const read = await adapter.posts.get(
    { ...delivery("instagram"), kind: "platform-post", postId: "post_example" },
    context,
  );

  assert.deepEqual(
    {
      allowedActions: read["allowedActions"],
      notificationStatus: read["notificationStatus"],
      ideaId: read["ideaId"],
      via: read["via"],
      createdAt: read["createdAt"],
      postType: read["postType"],
      tags: read["tags"],
      assets: read["assets"],
      author: read["author"],
    },
    {
      allowedActions: ["viewPost", "duplicatePost"],
      notificationStatus: "markedAsPublished",
      ideaId: "idea_1",
      via: "api",
      createdAt: "2026-11-01T09:00:00.000Z",
      postType: "post",
      tags: [{ id: "tag_launch", name: "Launch", color: "#F523F1" }],
      assets: [
        {
          type: "image",
          url: "https://cdn.buffer.com/a.gif",
          thumbnailUrl: "https://cdn.buffer.com/a-thumb.jpg",
          mimeType: "image/gif",
          altText: "A chart",
          animatedThumbnail: "https://cdn.buffer.com/a-anim.gif",
        },
      ],
      author: { id: "acct_1", name: "Sam" },
    },
  );

  const query = string(operations.at(-1)?.query);

  for (const field of ["allowedActions", "notificationStatus", "ideaId", "via", "author"])
    assert.match(query, new RegExp(`\\b${field}\\b`));
});

it("Buffer submits or withdraws a draft for approval with approvalChange [feature:buffer.edit.approval_change]", async () => {
  const { adapter, operations } = fakeBuffer((operation) =>
    operation.query.includes("editPost")
      ? { editPost: { post: post("x", { status: "needs_approval" }) } }
      : { post: post("x", { status: "draft" }) },
  );

  const outcome = await adapter.native.editPost(
    delivery("x"),
    { approvalChange: "request" },
    context,
  );

  assert.equal(outcome.state, "accepted");
  assert.deepEqual(
    operations.find((operation) => operation.query.includes("editPost"))?.variables["input"],
    { id: "post_example", approvalChange: "request" },
  );

  const scheduled = fakeBuffer(() => ({ post: post("x") }));

  await assert.rejects(
    scheduled.adapter.native.editPost(delivery("x"), { approvalChange: "revert" }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Buffer marks AI-assisted posts and links a draftId on create and edit [feature:buffer.publish.provenance]", async () => {
  const { input } = await publish(
    "x",
    { text: "Drafted with help" },
    {
      aiAssisted: true,
      draftId: "draft_9",
    },
  );

  assert.equal(input?.["aiAssisted"], true);
  assert.equal(input?.["draftId"], "draft_9");

  const { adapter, operations } = fakeBuffer((operation) =>
    operation.query.includes("editPost") ? { editPost: { post: post("x") } } : { post: post("x") },
  );

  await adapter.native.editPost(
    delivery("x"),
    { text: "Rewritten", aiAssisted: true, draftId: "draft_9" },
    context,
  );

  assert.deepEqual(
    operations.find((operation) => operation.query.includes("editPost"))?.variables["input"],
    { id: "post_example", text: "Rewritten", aiAssisted: true, draftId: "draft_9" },
  );

  const bad = await publish("x", { text: "x" }, { aiAssisted: "yes" });

  assert.deepEqual(bad.issues, ["options.boolean"]);
});

it("Buffer sends an image thumbnailUrl and animatedThumbnail, and rejects video thumbnails [feature:buffer.media.image_thumbnails]", async () => {
  const { input } = await publish(
    "linkedin",
    {
      text: "Animated chart",
      media: [
        image("chart", {
          altText: "A growing chart",
          thumbnail: { kind: "https-url", url: "https://cdn.example.test/chart-still.jpg" },
        }),
        image("loop"),
      ],
    },
    {
      animatedThumbnails: [
        { imageIndex: 0, url: "https://cdn.example.test/chart-preview.gif" },
        { imageIndex: 1, url: "https://cdn.example.test/loop-preview.gif" },
      ],
    },
  );

  assert.deepEqual(input?.["assets"], [
    {
      image: {
        url: "https://cdn.example.test/chart.gif",
        thumbnailUrl: "https://cdn.example.test/chart-still.jpg",
        metadata: {
          altText: "A growing chart",
          animatedThumbnail: "https://cdn.example.test/chart-preview.gif",
        },
      },
    },
    {
      image: {
        url: "https://cdn.example.test/loop.gif",
        metadata: { altText: "", animatedThumbnail: "https://cdn.example.test/loop-preview.gif" },
      },
    },
  ]);

  const withVideoThumbnail = await publish("linkedin", {
    text: "Clip",
    media: [
      {
        kind: "video",
        source: { kind: "https-url", url: "https://cdn.example.test/clip.mp4" },
        mimeType: "video/mp4",
        thumbnail: { kind: "https-url", url: "https://cdn.example.test/poster.jpg" },
      },
    ],
  });

  assert.deepEqual(withVideoThumbnail.issues, ["media.thumbnail_unsupported"]);

  const wrongIndex = await publish(
    "linkedin",
    { text: "x", media: [image("a")] },
    { animatedThumbnails: [{ imageIndex: 3, url: "https://cdn.example.test/p.gif" }] },
  );

  assert.deepEqual(wrongIndex.issues, ["buffer.animated_thumbnail"]);
});

it("Buffer publishes Substack Notes with text, one image, or a link card [feature:buffer.publish.substack]", async () => {
  const card = await publish("substack", {
    text: "New essay is out",
    link: { url: "https://example.substack.com/p/essay", title: "The essay" },
  });

  assert.deepEqual(card.issues, []);
  assert.equal(card.input?.["channelId"], "channel_substack");
  assert.deepEqual(object(card.input?.["metadata"])["substack"], {
    linkAttachment: { url: "https://example.substack.com/p/essay", title: "The essay" },
  });
  assert.equal(card.outcome?.state, "scheduled");

  const photo = await publish("substack", { text: "Cover art", media: [image("cover")] });

  assert.deepEqual(photo.issues, []);
  assert.deepEqual(photo.input?.["assets"], [
    { image: { url: "https://cdn.example.test/cover.gif" } },
  ]);

  const two = await publish("substack", { text: "Two", media: [image("a"), image("b")] });

  assert.deepEqual(two.issues, ["substack.media_count"]);

  const long = await publish("substack", { text: "a".repeat(10_001) });

  assert.deepEqual(long.issues, ["substack.text_too_long"]);
});
