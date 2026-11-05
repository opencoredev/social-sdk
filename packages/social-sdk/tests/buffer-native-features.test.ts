import { it } from "node:test";
import assert from "node:assert/strict";
import {
  connectedAccountRef,
  createSocial,
  type ConnectedAccountRef,
  type Platform,
  type PublishOptionsFor,
} from "../src/index.js";
import { buffer, bufferAuthorizationUrl } from "../src/cloud/buffer.js";
import { SocialError } from "../src/core/errors.js";
import type {
  AdapterOperationContext,
  DeliveryRef,
  JsonObject,
  JsonValue,
  MediaAttachment,
  PublishContent,
} from "../src/core/types.js";
import { definedFields } from "../src/core/fields.js";
import { isJsonValue } from "../src/transport/json.js";
import { object, string } from "../src/transport/validation.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-10-09T12:00:00.000Z");

const future = "2026-10-10T15:00:00.000Z";

const services: Partial<Record<Platform, string>> = {
  x: "twitter",
  threads: "threads",
  bluesky: "bluesky",
  mastodon: "mastodon",
  instagram: "instagram",
  facebook: "facebook",
  linkedin: "linkedin",
  youtube: "youtube",
  tiktok: "tiktok",
  pinterest: "pinterest",
  "google-business": "googlebusiness",
};

const channelId = (platform: Platform) => `channel_${platform}`;

const ref = (platform: Platform) =>
  connectedAccountRef({ backend: "default", platform, accountId: channelId(platform) });

const image = (name: string, altText?: string): MediaAttachment => ({
  kind: "image",
  source: { kind: "https-url", url: `https://cdn.example.test/${name}.jpg` },
  mimeType: "image/jpeg",
  ...definedFields({ altText }),
});

const video: MediaAttachment = {
  kind: "video",
  source: { kind: "https-url", url: "https://cdn.example.test/clip.mp4" },
  mimeType: "video/mp4",
};

const post = (platform: Platform, fields: JsonObject = {}): JsonObject => ({
  id: "post_example",
  text: "Hello",
  channelId: channelId(platform),
  channelService: string(services[platform]),
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

/** A fake Buffer GraphQL API: channels for every platform, plus `answer` for other operations. */
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
          channels: Object.entries(services).map(([platform, service]) => ({
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

/** Prepare and publish one target, returning the `createPost` input Buffer received. */
async function publish(
  platform: Platform,
  content: PublishContent,
  options: PublishOptionsFor<Platform>,
  schedule?: { readonly at: string },
  reply: (input: JsonObject) => JsonObject = () => post(platform),
) {
  const { adapter, operations } = fakeBuffer((operation) =>
    operation.query.includes("createPost")
      ? { createPost: { post: reply(object(operation.variables["input"])) } }
      : null,
  );

  const social = createSocial({ backend: adapter, clock });

  const request = {
    targets: [{ account: ref(platform), options }],
    content,
    ...definedFields({ schedule }),
  };

  const prepared = social.posts.prepare(request);
  const result = prepared.ok ? await social.posts.publish(request) : undefined;
  const create = operations.find((operation) => operation.query.includes("createPost"));

  return {
    issues: prepared.issues.map((issue) => issue.code),
    outcome: result?.outcomes[0],
    input: create === undefined ? undefined : object(create.variables["input"]),
  };
}

const metadataOf = (input: JsonObject | undefined, service: string): JsonValue | undefined =>
  input === undefined ? undefined : object(input["metadata"])[service];

const instagramBase = { shareToFeed: true };

const youtubeBase = {
  title: "Release walkthrough",
  categoryId: "22",
  visibility: "unlisted",
  madeForKids: false,
};

it("Buffer requests the ideas, snippets, and notes scopes it documents [feature:buffer.publish.templates_notes_snippets]", () => {
  const url = new URL(
    bufferAuthorizationUrl({
      clientId: "client_example",
      redirectUri: "https://app.example/buffer/callback",
      state: "state-example",
      codeChallenge: "challenge",
      scopes: ["posts:read", "ideas:read", "ideas:write", "snippets:read", "notes:read"],
    }),
  );

  assert.equal(
    url.searchParams.get("scope"),
    "posts:read ideas:read ideas:write snippets:read notes:read",
  );
});

it("Buffer adds a post to the queue or the next slot", async () => {
  for (const shareMode of ["addToQueue", "shareNext"]) {
    const { input, outcome } = await publish("x", { text: "Queued" }, { shareMode });

    assert.equal(input?.["mode"], shareMode);
    assert.equal(input?.["dueAt"], undefined);
    assert.equal(outcome?.state, "scheduled");
  }

  const both = await publish("x", { text: "Queued" }, { shareMode: "addToQueue" }, { at: future });

  assert.ok(both.issues.includes("buffer.share_mode"));
});

it("Buffer sends reminder posts and never reports them published [feature:buffer.scheduling.notification]", async () => {
  const { input } = await publish(
    "x",
    { text: "Remind me" },
    { schedulingType: "notification" },
    {
      at: future,
    },
  );

  assert.equal(input?.["schedulingType"], "notification");

  const { adapter } = fakeBuffer(() => ({
    post: post("x", { status: "sent", schedulingType: "notification" }),
  }));

  const delivery: DeliveryRef = {
    kind: "delivery",
    version: 1,
    backend: "default",
    platform: "x",
    accountId: channelId("x"),
    deliveryId: "post_example",
  };

  const outcome = await adapter.posts.getDelivery(delivery, context);

  assert.equal(outcome.state, "unknown");
});

it("Buffer saves drafts and submits posts for approval [feature:buffer.publish.draft]", async () => {
  const draft = await publish("x", { text: "Draft" }, { saveToDraft: true }, undefined, () =>
    post("x", { status: "draft" }),
  );

  assert.equal(draft.input?.["saveToDraft"], true);
  assert.equal(draft.input?.["needsApproval"], false);
  assert.equal(draft.outcome?.state, "accepted");

  const approval = await publish("x", { text: "Approve" }, { needsApproval: true }, undefined, () =>
    post("x", { status: "needs_approval" }),
  );

  assert.equal(approval.input?.["needsApproval"], true);
  assert.equal(approval.outcome?.state, "accepted");

  const conflict = await publish("x", { text: "x" }, { needsApproval: true, saveToDraft: false });

  assert.ok(conflict.issues.includes("buffer.approval"));
});

it("Buffer sends tagIds and links a post to an ideaId", async () => {
  const { input } = await publish(
    "x",
    { text: "Tagged" },
    {
      tagIds: ["tag_launch", "tag_q3"],
      ideaId: "idea_example",
    },
  );

  assert.deepEqual(input?.["tagIds"], ["tag_launch", "tag_q3"]);
  assert.equal(input?.["ideaId"], "idea_example");
  assert.ok(
    (await publish("x", { text: "x" }, { tagIds: ["has space"] })).issues.includes("buffer.tags"),
  );
});

it("Buffer creates an idea with createIdea", async () => {
  const { adapter, operations } = fakeBuffer(() => ({
    createIdea: { idea: { id: "idea_example" } },
  }));

  assert.deepEqual(
    await adapter.native.createIdea({ title: "Launch thread", text: "Outline" }, context),
    { id: "idea_example" },
  );
  assert.ok(operations[0]?.query.includes("createIdea"));
  assert.deepEqual(operations[0]?.variables["input"], {
    organizationId: "org_example",
    content: { title: "Launch thread", text: "Outline" },
  });

  const limited = fakeBuffer(() => ({ createIdea: { message: "Idea limit reached" } }));

  await assert.rejects(
    limited.adapter.native.createIdea({ title: "One more" }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Buffer edits an unsent post with editPost", async () => {
  const { adapter, operations } = fakeBuffer((operation) =>
    operation.query.includes("editPost")
      ? { editPost: { post: post("x", { text: "Edited" }) } }
      : { post: post("x") },
  );

  const job = {
    kind: "scheduled-job" as const,
    version: 1 as const,
    backend: "default",
    platform: "x" as const,
    accountId: channelId("x"),
    jobId: "post_example",
  };

  const outcome = await adapter.native.editPost(
    job,
    { text: "Edited", at: "2026-10-11T09:00:00.000Z", tagIds: ["tag_launch"] },
    context,
  );

  assert.equal(outcome.state, "scheduled");

  const edit = operations.find((operation) => operation.query.includes("editPost"));

  assert.deepEqual(edit?.variables["input"], {
    id: "post_example",
    text: "Edited",
    dueAt: "2026-10-11T09:00:00.000Z",
    mode: "customScheduled",
    tagIds: ["tag_launch"],
  });

  await assert.rejects(
    adapter.native.editPost(job, {}, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );

  const sent = fakeBuffer(() => ({ post: post("x", { status: "sent" }) }));

  await assert.rejects(
    sent.adapter.native.editPost(job, { text: "Too late" }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Buffer moves a queued post with movePostInQueue and reads dailyPostingLimits", async () => {
  const { adapter, operations } = fakeBuffer((operation) => {
    if (operation.query.includes("movePostInQueue"))
      return { movePostInQueue: { post: post("x", { shareMode: "addToQueue" }) } };

    if (operation.query.includes("dailyPostingLimits"))
      return {
        dailyPostingLimits: [
          { channelId: channelId("x"), isAtLimit: false, limit: 17, scheduled: 4, sent: 2 },
          { channelId: channelId("linkedin"), isAtLimit: true, limit: null, scheduled: 0, sent: 0 },
        ],
      };

    return { post: post("x") };
  });

  const job = {
    kind: "scheduled-job" as const,
    version: 1 as const,
    backend: "default",
    platform: "x" as const,
    accountId: channelId("x"),
    jobId: "post_example",
  };

  assert.equal((await adapter.native.movePostInQueue(job, "top", context)).state, "scheduled");
  assert.deepEqual(
    operations.find((operation) => operation.query.includes("movePostInQueue"))?.variables,
    { input: { id: "post_example", position: "top" } },
  );

  assert.deepEqual(
    await adapter.native.dailyPostingLimits([ref("x"), ref("linkedin")], { at: future }, context),
    [
      { channelId: channelId("x"), isAtLimit: false, limit: 17, scheduled: 4, sent: 2 },
      { channelId: channelId("linkedin"), isAtLimit: true, scheduled: 0, sent: 0 },
    ],
  );
  assert.deepEqual(
    operations.find((operation) => operation.query.includes("dailyPostingLimits"))?.variables,
    { input: { channelIds: [channelId("x"), channelId("linkedin")], date: future } },
  );
});

it("Buffer sets a video cover frame with thumbnailOffset", async () => {
  const { input } = await publish(
    "instagram",
    { text: "Reel", media: [video] },
    { ...instagramBase, postType: "reel", thumbnailOffset: 2500 },
  );

  assert.deepEqual(input?.["assets"], [
    { video: { url: "https://cdn.example.test/clip.mp4", metadata: { thumbnailOffset: 2500 } } },
  ]);
  assert.ok(
    (await publish("x", { text: "Clip", media: [video] }, { thumbnailOffset: 1 })).issues.includes(
      "options.unmapped",
    ),
  );
});

it("Buffer tags Instagram accounts on an image with userTags", async () => {
  const { input } = await publish(
    "instagram",
    { text: "Team", media: [image("team", "The team")] },
    { ...instagramBase, userTags: [{ handle: "partner", x: 0.5, y: 0.25 }] },
  );

  assert.deepEqual(input?.["assets"], [
    {
      image: {
        url: "https://cdn.example.test/team.jpg",
        metadata: { altText: "The team", userTags: [{ handle: "partner", x: 0.5, y: 0.25 }] },
      },
    },
  ]);

  const noAlt = await publish(
    "instagram",
    { text: "Team", media: [image("team")] },
    { ...instagramBase, userTags: [{ handle: "partner", x: 2, y: 0 }] },
  );

  assert.ok(noAlt.issues.includes("instagram.user_tags"));

  // An empty altText passes preparation, so the tags must still reach Buffer with altText "".
  const emptyAlt = await publish(
    "instagram",
    { text: "Team", media: [image("team", "")] },
    { ...instagramBase, userTags: [{ handle: "partner", x: 0.5, y: 0.5 }] },
  );

  assert.deepEqual(emptyAlt.issues, []);
  assert.deepEqual(emptyAlt.input?.["assets"], [
    {
      image: {
        url: "https://cdn.example.test/team.jpg",
        metadata: { altText: "", userTags: [{ handle: "partner", x: 0.5, y: 0.5 }] },
      },
    },
  ]);
});

it("Buffer sends the shared userTags username and mediaIndex as handle and image", async () => {
  const account: ConnectedAccountRef<"instagram"> = connectedAccountRef({
    backend: "default",
    platform: "instagram",
    accountId: channelId("instagram"),
  });

  const options: PublishOptionsFor<"instagram"> = {
    shareToFeed: true,
    userTags: [
      { username: "@partner", x: 0.5, y: 0.25 },
      { username: "friend", x: 0.1, y: 0.9, mediaIndex: 1 },
    ],
  };

  const { input, issues } = await publish(
    account.platform,
    { text: "Team", media: [image("team", "The team"), image("crew", "The crew")] },
    options,
  );

  assert.deepEqual(issues, []);
  assert.deepEqual(input?.["assets"], [
    {
      image: {
        url: "https://cdn.example.test/team.jpg",
        metadata: { altText: "The team", userTags: [{ handle: "partner", x: 0.5, y: 0.25 }] },
      },
    },
    {
      image: {
        url: "https://cdn.example.test/crew.jpg",
        metadata: { altText: "The crew", userTags: [{ handle: "friend", x: 0.1, y: 0.9 }] },
      },
    },
  ]);

  // A tag names its account once: `username` or the Buffer-only `handle`, not both.
  const twice = await publish(
    "instagram",
    { text: "Team", media: [image("team", "The team")] },
    { ...instagramBase, userTags: [{ username: "partner", handle: "partner", x: 0.5, y: 0.5 }] },
  );

  assert.ok(twice.issues.includes("instagram.user_tags"));
});

it("Buffer sends content.link as a linkAttachment card", async () => {
  const { input, issues } = await publish(
    "linkedin",
    {
      text: "New on the blog",
      link: { url: "https://example.test/post", title: "The post", description: "Why" },
    },
    {},
  );

  assert.deepEqual(issues, []);
  assert.deepEqual(input?.["assets"], []);
  assert.deepEqual(metadataOf(input, "linkedin"), {
    linkAttachment: { url: "https://example.test/post", title: "The post", description: "Why" },
  });

  const withMedia = await publish(
    "bluesky",
    { text: "x", media: [image("a")], link: { url: "https://example.test/post" } },
    {},
  );

  assert.ok(withMedia.issues.includes("link.with_media"));
  assert.ok(
    (
      await publish("x", { text: "x", link: { url: "https://example.test/post" } }, {})
    ).issues.includes("link.explicit_text"),
  );
});

it("Buffer publishes a link card without commentary", async () => {
  const { input, issues } = await publish(
    "linkedin",
    { link: { url: "https://example.test/post", title: "The post" } },
    {},
  );

  assert.deepEqual(issues, []);
  assert.equal(input?.["text"], "");
  assert.deepEqual(metadataOf(input, "linkedin"), {
    linkAttachment: { url: "https://example.test/post", title: "The post" },
  });
});

it("Buffer adds a firstComment on Instagram, Facebook, and LinkedIn", async () => {
  const { input } = await publish(
    "facebook",
    { text: "Launch" },
    { firstComment: "Link: https://example.test" },
  );

  assert.deepEqual(metadataOf(input, "facebook"), {
    firstComment: "Link: https://example.test",
    type: "post",
  });
  assert.ok(
    (await publish("x", { text: "x" }, { firstComment: "nope" })).issues.includes(
      "options.unmapped",
    ),
  );
});

it("Buffer publishes a thread with the root post first [feature:buffer.publish.threads_native]", async () => {
  const { input } = await publish(
    "threads",
    { text: "1/ Launch", media: [image("cover")] },
    { thread: [{ text: "2/ Details" }, { text: "3/ Try it" }] },
  );

  assert.deepEqual(metadataOf(input, "threads"), {
    thread: [
      { text: "1/ Launch", assets: [{ image: { url: "https://cdn.example.test/cover.jpg" } }] },
      { text: "2/ Details", assets: [] },
      { text: "3/ Try it", assets: [] },
    ],
  });
  assert.equal(input?.["text"], "1/ Launch");
  assert.ok(
    (await publish("linkedin", { text: "x" }, { thread: [{ text: "y" }] })).issues.includes(
      "buffer.thread_unsupported",
    ),
  );
});

it("Buffer maps X AI labels, reposts, and quotes", async () => {
  const labelled = await publish("x", { text: "Generated" }, { aiGenerated: true });

  assert.deepEqual(metadataOf(labelled.input, "twitter"), { isAiGenerated: true });

  const quote = await publish(
    "x",
    { text: "" },
    { retweet: { id: "1849", comment: "Worth reading" } },
  );

  assert.deepEqual(metadataOf(quote.input, "twitter"), {
    retweet: { id: "1849", comment: "Worth reading" },
  });
  assert.ok(
    (
      await publish("x", { text: "x" }, { retweet: { id: "1849" }, aiGenerated: true })
    ).issues.includes("x.retweet"),
  );
});

it("Buffer posts Instagram stories and reels [feature:buffer.publish.instagram.story_reel]", async () => {
  const story = await publish(
    "instagram",
    { media: [image("story")] },
    { ...instagramBase, postType: "story" },
  );

  assert.deepEqual(metadataOf(story.input, "instagram"), {
    shouldShareToFeed: true,
    type: "story",
  });

  const reel = await publish(
    "instagram",
    { media: [video] },
    { ...instagramBase, postType: "reel" },
  );

  assert.deepEqual(metadataOf(reel.input, "instagram"), { shouldShareToFeed: true, type: "reel" });
  assert.ok(
    (
      await publish("instagram", { media: [image("a")] }, { ...instagramBase, postType: "reel" })
    ).issues.includes("instagram.post_type"),
  );
});

it("Buffer maps Instagram location, Shop Grid link, AI label, and first comment [feature:buffer.publish.instagram.extras]", async () => {
  const { input } = await publish(
    "instagram",
    { text: "Shop", media: [image("shop")] },
    {
      ...instagramBase,
      location: { id: "213385402", name: "Berlin" },
      shopGridLink: "https://shop.example.test/item",
      aiGenerated: false,
      firstComment: "#launch",
    },
  );

  assert.deepEqual(metadataOf(input, "instagram"), {
    shouldShareToFeed: true,
    type: "post",
    firstComment: "#launch",
    link: "https://shop.example.test/item",
    geolocation: { id: "213385402", text: "Berlin" },
    isAiGenerated: false,
  });
});

it("Buffer searches Instagram audio for reference [feature:buffer.publish.instagram.audio]", async () => {
  const { adapter, operations } = fakeBuffer(() => ({
    searchInstagramAudio: {
      audio: [
        {
          id: "587784541076604",
          title: "Summer Vibes",
          type: "music",
          duration: 30000,
          displayArtist: "Some Artist",
          creatorUsername: null,
        },
      ],
    },
  }));

  assert.deepEqual(
    await adapter.native.searchInstagramAudio(
      ref("instagram"),
      { query: "summer", audioType: "music" },
      context,
    ),
    [
      {
        id: "587784541076604",
        title: "Summer Vibes",
        type: "music",
        durationMs: 30000,
        displayArtist: "Some Artist",
      },
    ],
  );
  assert.deepEqual(operations.at(-1)?.variables, {
    input: { channelId: channelId("instagram"), query: "summer", audioType: "music" },
  });

  const refresh = fakeBuffer(() => ({ searchInstagramAudio: { message: "Refresh the channel" } }));

  await assert.rejects(
    refresh.adapter.native.searchInstagramAudio(
      ref("instagram"),
      { query: "summer", audioType: "music" },
      context,
    ),
    (error) => error instanceof SocialError && error.code === "reconnect_required",
  );
});

it("Buffer posts Facebook reels and stories [feature:buffer.publish.facebook.type]", async () => {
  const reel = await publish("facebook", { text: "Reel", media: [video] }, { postType: "reel" });

  assert.deepEqual(metadataOf(reel.input, "facebook"), { type: "reel" });

  const story = await publish("facebook", { media: [image("s")] }, { postType: "story" });

  assert.deepEqual(metadataOf(story.input, "facebook"), { type: "story" });
});

it("Buffer sends LinkedIn mention annotations [feature:buffer.publish.linkedin.annotations]", async () => {
  const annotation = {
    id: "1521226",
    entity: "urn:li:organization:1521226",
    length: 6,
    link: "https://www.linkedin.com/company/bufferapp",
    localizedName: "Buffer",
    start: 5,
    vanityName: "bufferapp",
  };

  const { input } = await publish(
    "linkedin",
    { text: "With Buffer today" },
    { annotations: [annotation] },
  );

  assert.deepEqual(metadataOf(input, "linkedin"), { annotations: [annotation] });
  assert.ok(
    (
      await publish("linkedin", { text: "x" }, { annotations: [{ ...annotation, start: -1 }] })
    ).issues.includes("linkedin.annotations"),
  );
});

it("Buffer maps a Threads topic and locationName", async () => {
  const { input } = await publish(
    "threads",
    { text: "Hello" },
    {
      topic: "Product",
      location: { id: "loc_1", name: "Lisbon" },
    },
  );

  assert.deepEqual(metadataOf(input, "threads"), {
    topic: "Product",
    locationId: "loc_1",
    locationName: "Lisbon",
  });
});

it("Buffer hides a Mastodon post behind spoilerText", async () => {
  const { input } = await publish("mastodon", { text: "Spoilers" }, { spoilerText: "Finale" });

  assert.deepEqual(metadataOf(input, "mastodon"), { spoilerText: "Finale" });
});

it("Buffer maps YouTube embeddable, license, notifySubscribers, and AI label", async () => {
  const { input } = await publish(
    "youtube",
    { text: "Watch", media: [video] },
    {
      ...youtubeBase,
      embeddable: false,
      license: "creativeCommon",
      notifySubscribers: false,
      aiGenerated: true,
    },
  );

  assert.deepEqual(metadataOf(input, "youtube"), {
    title: "Release walkthrough",
    categoryId: "22",
    privacy: "unlisted",
    madeForKids: false,
    embeddable: false,
    notifySubscribers: false,
    isAiGenerated: true,
    license: "creativeCommon",
  });
  assert.ok(
    (
      await publish(
        "youtube",
        { text: "Watch", media: [video] },
        { ...youtubeBase, license: "mit" },
      )
    ).issues.includes("youtube.license"),
  );
});

it("Buffer titles a TikTok photo post [feature:buffer.publish.tiktok]", async () => {
  const { input } = await publish(
    "tiktok",
    { text: "Photos", media: [image("a"), image("b")] },
    { title: "Weekend", aiGenerated: false },
  );

  assert.deepEqual(metadataOf(input, "tiktok"), { isAiGenerated: false, title: "Weekend" });
  assert.ok(
    (await publish("tiktok", { text: "Clip", media: [video] }, { title: "No" })).issues.includes(
      "tiktok.title",
    ),
  );
});

it("Buffer maps Google Business whats_new, event, and offer posts", async () => {
  const update = await publish(
    "google-business",
    { text: "New menu" },
    {
      callToAction: { type: "learn_more", url: "https://example.test/menu" },
    },
  );

  assert.deepEqual(metadataOf(update.input, "google"), {
    type: "whats_new",
    detailsWhatsNew: { button: "learn_more", link: "https://example.test/menu" },
  });

  const event = await publish(
    "google-business",
    { text: "Open day" },
    {
      postType: "event",
      event: {
        title: "Open day",
        startDate: "2026-10-20T09:00:00.000Z",
        endDate: "2026-10-20T17:00:00.000Z",
        isFullDayEvent: false,
      },
    },
  );

  assert.deepEqual(metadataOf(event.input, "google"), {
    type: "event",
    detailsEvent: {
      title: "Open day",
      startDate: "2026-10-20T09:00:00.000Z",
      endDate: "2026-10-20T17:00:00.000Z",
      isFullDayEvent: false,
    },
  });

  const offer = await publish(
    "google-business",
    { text: "20% off" },
    {
      postType: "offer",
      offer: {
        title: "Autumn sale",
        startDate: "2026-10-01T00:00:00.000Z",
        endDate: "2026-10-31T00:00:00.000Z",
        code: "SAVE20",
      },
    },
  );

  assert.deepEqual(metadataOf(offer.input, "google"), {
    type: "offer",
    detailsOffer: {
      title: "Autumn sale",
      startDate: "2026-10-01T00:00:00.000Z",
      endDate: "2026-10-31T00:00:00.000Z",
      code: "SAVE20",
    },
  });
  assert.ok(
    (await publish("google-business", { text: "x" }, { postType: "event" })).issues.includes(
      "google_business.event",
    ),
  );
});

it("Buffer reads aggregatedPostMetrics as a channel report", async () => {
  const { adapter, operations } = fakeBuffer(() => ({
    aggregatedPostMetrics: {
      metrics: [
        { type: "postCount", value: 12, unit: "count", name: "Posts" },
        { type: "reactions", value: 340, unit: "count", name: "Reactions" },
        { type: "engagementRate", value: 4.2, unit: "percentage", name: "Eng. Rate" },
      ],
      metricsUpdatedAt: "2026-10-09T06:00:00.000Z",
    },
  }));

  const social = createSocial({ backend: adapter, clock });

  const report = await social.analytics.getReport(ref("linkedin"), {
    from: "2026-07-01",
    to: "2026-09-30",
    metrics: ["postCount", "engagementRate"],
  });

  assert.deepEqual(report.rows, [
    {
      dimensions: { channelId: channelId("linkedin") },
      metrics: { postCount: 12, engagementRate: 4.2 },
    },
  ]);

  const aggregate = operations.find((operation) =>
    operation.query.includes("aggregatedPostMetrics"),
  );

  assert.deepEqual(aggregate?.variables, {
    input: {
      organizationId: "org_example",
      channelIds: [channelId("linkedin")],
      startDateTime: "2026-07-01T00:00:00.000Z",
      endDateTime: "2026-09-30T00:00:00.000Z",
    },
  });

  await assert.rejects(
    social.analytics.getReport(ref("linkedin"), {
      from: "2025-01-01",
      to: "2026-09-30",
      metrics: ["postCount"],
    }),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Buffer reports count the end date as a whole day within the 365-day cap", async () => {
  const { adapter, operations } = fakeBuffer(() => ({
    aggregatedPostMetrics: {
      metrics: [{ type: "postCount", value: 1, unit: "count", name: "Posts" }],
      metricsUpdatedAt: "2026-10-09T06:00:00.000Z",
    },
  }));

  const social = createSocial({ backend: adapter, clock });

  // Buffer documents endDateTime as UTC midnight of the last day, inclusive of that day.
  await social.analytics.getReport(ref("linkedin"), {
    from: "2026-09-30",
    to: "2026-09-30",
    metrics: ["postCount"],
  });

  assert.deepEqual(operations.at(-1)?.variables["input"], {
    organizationId: "org_example",
    channelIds: [channelId("linkedin")],
    startDateTime: "2026-09-30T00:00:00.000Z",
    endDateTime: "2026-09-30T00:00:00.000Z",
  });

  // 2025-01-01 through 2025-12-31 is 365 days; through 2026-01-01 is 366.
  await social.analytics.getReport(ref("linkedin"), {
    from: "2025-01-01",
    to: "2025-12-31",
    metrics: ["postCount"],
  });
  await assert.rejects(
    social.analytics.getReport(ref("linkedin"), {
      from: "2025-01-01",
      to: "2026-01-01",
      metrics: ["postCount"],
    }),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Buffer keeps only count and percentage metric units", async () => {
  const { adapter } = fakeBuffer(() => ({
    post: post("x", {
      status: "sent",
      metrics: [
        { type: "reactions", value: 3, unit: "count", name: "Reactions" },
        { type: "engagementRate", value: 1.5, unit: "percentage", name: "Eng. Rate" },
        { type: "totalTimeWatched", value: 9, unit: "seconds", name: "Watch time" },
      ],
      metricsUpdatedAt: "2026-10-09T06:00:00.000Z",
    }),
  }));

  const metrics = await adapter.analytics.getPostMetrics(
    {
      kind: "platform-post",
      version: 1,
      backend: "default",
      platform: "x",
      accountId: channelId("x"),
      postId: "post_example",
    },
    context,
  );

  assert.deepEqual(
    metrics.map((metric) => [metric.name, metric.unit]),
    [
      ["reactions", "count"],
      ["engagementRate", "percentage"],
    ],
  );
});

it("Buffer declares no webhook, comment, or message surface [feature:buffer.webhooks.none]", () => {
  const { adapter } = fakeBuffer(() => null);
  const operations = new Set(adapter.capabilities.capabilities.map((entry) => entry.operation));

  for (const surface of ["webhooks", "comments", "messages"])
    assert.equal(surface in adapter, false);

  for (const operation of ["webhooks.verify", "comments.read", "messages.read"])
    assert.equal(operations.has(operation), false);
});
