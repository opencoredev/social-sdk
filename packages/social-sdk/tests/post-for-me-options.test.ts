import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef, type PublishRequest } from "../src/index.js";
import { postForMe } from "../src/cloud/post-for-me.js";
import { definedFields } from "../src/core/fields.js";
import { isJsonValue } from "../src/transport/json.js";
import { array, object } from "../src/transport/validation.js";
import type {
  AdapterOperationContext,
  JsonObject,
  JsonValue,
  MediaAttachment,
} from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-11-04T12:00:00Z");

interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
}

function fake(routes: Readonly<Record<string, JsonValue>>) {
  const calls: Call[] = [];

  const adapter = postForMe({
    apiKey: "test",
    clock,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const parsed: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));

      calls.push({
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        ...definedFields({ body: isJsonValue(parsed) ? parsed : undefined }),
      });

      const answer = routes[`${method} ${url.pathname}`];

      if (answer === undefined) return Response.json({ message: "no route" }, { status: 404 });

      return Response.json(answer);
    },
  });

  return { adapter, native: adapter.native, calls };
}

const account = (platform: string) =>
  connectedAccountRef({ backend: "default", platform, accountId: "spc_1" });

const image = (name: string): MediaAttachment => ({
  kind: "image",
  mimeType: "image/png",
  source: { kind: "https-url", url: `https://cdn.example.test/${name}.png` },
});

const video: MediaAttachment = {
  kind: "video",
  mimeType: "video/mp4",
  source: { kind: "https-url", url: "https://cdn.example.test/clip.mp4" },
};

/** Publish one target and return the create-post body Post for Me received. */
async function sent(request: PublishRequest): Promise<JsonObject> {
  let captured: JsonObject | undefined;

  const social = createSocial({
    backend: postForMe({
      apiKey: "test",
      clock,
      fetch: async (input, init) => {
        assert.equal(new URL(String(input)).pathname, "/v1/social-posts");
        const parsed: unknown = JSON.parse(String(init?.body));

        if (!isJsonValue(parsed)) throw new Error("Body must be JSON.");
        captured = object(parsed);

        return Response.json({ id: "sp_1", status: "scheduled" });
      },
    }),
    clock,
  });

  await social.posts.publish(request);

  if (!captured) throw new Error("Post for Me received no create request.");

  return captured;
}

const configFor = (body: JsonObject, key: string) =>
  object(object(body["platform_configurations"])[key]);

function issues(request: PublishRequest): readonly string[] {
  return createSocial({ backend: postForMe({ apiKey: "test", clock }) })
    .posts.prepare(request)
    .issues.map((issue) => issue.code);
}

it("maps X poll, quote_tweet_id, community_id and the subscribers reply setting", async () => {
  const body = await sent({
    targets: [
      {
        account: account("x"),
        options: {
          poll: { options: ["Yes", "No"], durationMinutes: 60 },
          communityId: "1500",
          replySettings: "subscribers",
        },
      },
    ],
    content: { text: "Vote" },
  });

  assert.deepEqual(configFor(body, "x"), {
    poll: { options: ["Yes", "No"], duration_minutes: 60 },
    community_id: "1500",
    reply_settings: "subscribers",
  });

  const quote = await sent({
    targets: [{ account: account("x"), options: { quotePostId: "1748391029384756102" } }],
    content: { text: "This" },
  });

  assert.equal(configFor(quote, "x")["quote_tweet_id"], "1748391029384756102");
  assert.ok(
    issues({
      targets: [
        {
          account: account("x"),
          options: { poll: { options: ["a", "b"], durationMinutes: 60 }, quotePostId: "1" },
        },
      ],
      content: { text: "both" },
    }).includes("x.poll"),
  );
});

it("maps Instagram placement, collaborators, location, trial_reel_type, audio_name and AI label", async () => {
  const reel = await sent({
    targets: [
      {
        account: account("instagram"),
        options: {
          placement: "reels",
          collaborators: ["partner"],
          locationId: "105890561436614",
          trialReel: "manual",
          audioName: "Studio take",
          aiGenerated: true,
        },
      },
    ],
    content: { text: "Reel", media: [video] },
  });

  assert.deepEqual(configFor(reel, "instagram"), {
    placement: "reels",
    collaborators: ["partner"],
    location: "105890561436614",
    trial_reel_type: "manual",
    audio_name: "Studio take",
    is_ai_generated: true,
  });

  const story = await sent({
    targets: [{ account: account("instagram"), options: { placement: "story" } }],
    content: { media: [image("s")] },
  });

  assert.equal(configFor(story, "instagram")["placement"], "stories");
  assert.ok(
    issues({
      targets: [{ account: account("instagram"), options: { audioName: "x" } }],
      content: { media: [image("a")] },
    }).includes("instagram.reel_options"),
  );
});

it("maps Facebook Reel placement, collaborators, location and set_caption_for_each_image", async () => {
  const reel = await sent({
    targets: [
      {
        account: account("facebook"),
        options: { reel: true, collaborators: ["123"], locationId: "999" },
      },
    ],
    content: { text: "Reel", media: [video] },
  });

  assert.deepEqual(configFor(reel, "facebook"), {
    placement: "reels",
    collaborators: ["123"],
    location: "999",
  });

  const album = await sent({
    targets: [{ account: account("facebook"), options: { captionEachImage: true } }],
    content: { text: "Album", media: [image("a"), image("b")] },
  });

  assert.deepEqual(configFor(album, "facebook"), { set_caption_for_each_image: true });
});

it("maps YouTube tags, category_id, contains_synthetic_media and has_paid_product_placement", async () => {
  const body = await sent({
    targets: [
      {
        account: account("youtube"),
        options: {
          title: "Tour",
          visibility: "public",
          madeForKids: false,
          tags: ["sdk"],
          categoryId: "28",
          containsSyntheticMedia: false,
          paidProductPlacement: true,
        },
      },
    ],
    content: { text: "Tour", media: [video] },
  });

  assert.deepEqual(configFor(body, "youtube"), {
    tags: ["sdk"],
    category_id: "28",
    contains_synthetic_media: false,
    has_paid_product_placement: true,
    title: "Tour",
    privacy_status: "public",
    made_for_kids: false,
  });
});

it("maps TikTok followers and friends privacy for TikTok and TikTok Business accounts", async () => {
  const options = {
    privacy: "MUTUAL_FOLLOW_FRIENDS",
    consentGiven: true,
    disableComments: false,
    disableDuet: false,
    disableStitch: false,
    brandedContent: false,
    ownBrand: false,
    aiGenerated: false,
    draft: false,
  } as const;

  const body = await sent({
    targets: [{ account: account("tiktok"), options }],
    content: { text: "Clip", media: [video] },
  });

  assert.equal(configFor(body, "tiktok")["privacy_status"], "friends");
  assert.deepEqual(configFor(body, "tiktok_business"), configFor(body, "tiktok"));

  const followers = await sent({
    targets: [
      { account: account("tiktok"), options: { ...options, privacy: "FOLLOWER_OF_CREATOR" } },
    ],
    content: { text: "Clip", media: [video] },
  });

  assert.equal(configFor(followers, "tiktok")["privacy_status"], "followers");
});

it("sends TikTok photo title and auto_add_music [feature:post-for-me.publish.tiktok.title_music]", async () => {
  const body = await sent({
    targets: [
      {
        account: account("tiktok"),
        options: {
          privacy: "PUBLIC_TO_EVERYONE",
          consentGiven: true,
          disableComments: false,
          disableDuet: false,
          disableStitch: false,
          brandedContent: false,
          ownBrand: false,
          aiGenerated: false,
          draft: false,
          title: "Studio tour",
          autoAddMusic: true,
        },
      },
    ],
    content: { text: "Photos", media: [image("1"), image("2")] },
  });

  assert.equal(configFor(body, "tiktok")["title"], "Studio tour");
  assert.equal(configFor(body, "tiktok")["auto_add_music"], true);
  assert.ok(
    issues({
      targets: [
        {
          account: account("tiktok"),
          options: {
            privacy: "PUBLIC_TO_EVERYONE",
            consentGiven: true,
            disableComments: false,
            disableDuet: false,
            disableStitch: false,
            brandedContent: false,
            ownBrand: false,
            aiGenerated: false,
            draft: false,
            autoAddMusic: true,
          },
        },
      ],
      content: { media: [video] },
    }).includes("tiktok.photo_options"),
  );
});

it("lists TikTok Business accounts as TikTok", async () => {
  const { adapter } = fake({
    "GET /v1/social-accounts": {
      data: [{ id: "spc_tb", platform: "tiktok_business", user_id: "u1", username: "brand" }],
      meta: { next: null },
    },
  });

  const page = await adapter.accounts.list({}, context);

  assert.equal(page.items[0]?.ref.platform, "tiktok");
});

it("maps LinkedIn document title and reshare_post_id", async () => {
  const pdf: MediaAttachment = {
    kind: "document",
    mimeType: "application/pdf",
    source: { kind: "https-url", url: "https://cdn.example.test/report.pdf" },
  };

  const document = await sent({
    targets: [{ account: account("linkedin"), options: { documentTitle: "Report" } }],
    content: { text: "Read it", media: [pdf] },
  });

  assert.deepEqual(configFor(document, "linkedin"), { title: "Report" });

  const reshare = await sent({
    targets: [{ account: account("linkedin"), options: { reshare: "urn:li:ugcPost:7000" } }],
    content: { text: "Worth it" },
  });

  assert.deepEqual(configFor(reshare, "linkedin"), { reshare_post_id: "urn:li:ugcPost:7000" });
});

it("pins to several Pinterest boards [feature:post-for-me.publish.pinterest]", async () => {
  const body = await sent({
    targets: [{ account: account("pinterest"), options: { boardIds: ["b1", "b2"], title: "Pin" } }],
    content: { text: "Pin", media: [image("p")] },
  });

  assert.deepEqual(configFor(body, "pinterest"), { board_ids: ["b1", "b2"], title: "Pin" });
  assert.ok(
    issues({
      targets: [{ account: account("pinterest"), options: { boardIds: ["b1"], boardId: "b2" } }],
      content: { media: [image("p")] },
    }).includes("pinterest.board"),
  );
});

it("sends media tags as given, x and y unchanged [feature:post-for-me.media.user_tags]", async () => {
  const body = await sent({
    targets: [
      {
        account: account("instagram"),
        options: {
          mediaOptions: [
            {
              tags: [
                { id: "studio.account", type: "user", platform: "instagram", x: 42.5, y: 0.25 },
                { id: "prod_88", type: "product", platform: "instagram", x: 10, y: 90 },
              ],
            },
            {
              skipProcessing: true,
              tags: [{ id: "studio.second", type: "user", platform: "instagram" }],
            },
          ],
        },
      },
    ],
    content: { text: "Tagged", media: [image("t1"), image("t2")] },
  });

  assert.deepEqual(body, {
    caption: "Tagged",
    social_accounts: ["spc_1"],
    media: [
      {
        url: "https://cdn.example.test/t1.png",
        tags: [
          { id: "studio.account", type: "user", platform: "instagram", x: 42.5, y: 0.25 },
          { id: "prod_88", type: "product", platform: "instagram", x: 10, y: 90 },
        ],
      },
      {
        url: "https://cdn.example.test/t2.png",
        skip_processing: true,
        tags: [{ id: "studio.second", type: "user", platform: "instagram" }],
      },
    ],
  });

  const facebook = await sent({
    targets: [
      {
        account: account("facebook"),
        options: {
          mediaOptions: [
            { tags: [{ id: "100045", type: "user", platform: "facebook", x: 50, y: 50 }] },
          ],
        },
      },
    ],
    content: { media: [image("f")] },
  });

  assert.deepEqual(array(facebook["media"]), [
    {
      url: "https://cdn.example.test/f.png",
      tags: [{ id: "100045", type: "user", platform: "facebook", x: 50, y: 50 }],
    },
  ]);

  const rejected = (platform: string, tag: JsonObject) =>
    issues({
      targets: [{ account: account(platform), options: { mediaOptions: [{ tags: [tag] }] } }],
      content: { media: [image("r")] },
    });

  assert.ok(
    rejected("facebook", { id: "p1", type: "product", platform: "facebook" }).includes(
      "media.tags",
    ),
  );
  assert.ok(
    rejected("facebook", { id: "u1", type: "user", platform: "instagram" }).includes("media.tags"),
  );
  assert.ok(
    rejected("x", { id: "u1", type: "user", platform: "instagram" }).includes("media.tags"),
  );
  assert.ok(
    rejected("instagram", { id: "u1", type: "user", platform: "instagram", x: "50" }).includes(
      "media.tags",
    ),
  );
  assert.ok(
    rejected("instagram", { id: "", type: "user", platform: "instagram" }).includes("media.tags"),
  );
  assert.ok(
    rejected("instagram", { id: "u1", type: "user", platform: "instagram", scale: 1 }).includes(
      "media.tags",
    ),
  );
  assert.deepEqual(
    issues({
      targets: [{ account: account("instagram"), options: { mediaOptions: [{ tags: [] }] } }],
      content: { media: [image("r")] },
    }),
    ["media.tags"],
  );
});

it("sends Threads placement unchanged [feature:post-for-me.publish.threads.placement]", async () => {
  for (const placement of ["reels", "timeline"] as const) {
    const body = await sent({
      targets: [{ account: account("threads"), options: { placement } }],
      content: { text: "Placed", media: [video] },
    });

    assert.deepEqual(body, {
      caption: "Placed",
      social_accounts: ["spc_1"],
      media: [{ url: "https://cdn.example.test/clip.mp4" }],
      platform_configurations: { threads: { placement } },
    });
  }

  assert.deepEqual(
    issues({
      targets: [{ account: account("threads"), options: { placement: "feed" } }],
      content: { text: "Placed" },
    }),
    ["threads.placement"],
  );
});

it("sends media alt_text and a video thumbnail_url", async () => {
  const body = await sent({
    targets: [{ account: account("x") }],
    content: {
      text: "Alt",
      media: [
        { ...image("a"), altText: "A chart of growth" },
        { ...video, thumbnail: { kind: "https-url", url: "https://cdn.example.test/cover.jpg" } },
      ],
    },
  });

  assert.deepEqual(array(body["media"]), [
    { url: "https://cdn.example.test/a.png", alt_text: "A chart of growth" },
    {
      url: "https://cdn.example.test/clip.mp4",
      thumbnail_url: "https://cdn.example.test/cover.jpg",
    },
  ]);
});

it("reads Instagram saved and Reel watch time metrics", async () => {
  const { adapter } = fake({
    "GET /v1/social-account-feeds/spc_1": {
      data: [
        {
          platform_post_id: "ig1",
          social_account_id: "spc_1",
          metrics: { likes: 4, saved: 2, ig_reels_avg_watch_time: 1500 },
        },
      ],
    },
  });

  const metrics = await adapter.analytics.getPostMetrics(
    {
      kind: "platform-post",
      version: 1,
      backend: "default",
      platform: "instagram",
      accountId: "spc_1",
      postId: "ig1",
    },
    context,
  );

  assert.deepEqual(
    metrics.map((metric) => [metric.name, metric.value, metric.unit]),
    [
      ["likes", 4, "count"],
      ["saves", 2, "count"],
      ["averageWatchTime", 1500, "milliseconds"],
    ],
  );
});

it("starts connections with platform_data and force_reauth at /v1/social-accounts/auth-url", async () => {
  const { native, calls } = fake({
    "POST /v1/social-accounts/auth-url": {
      url: "https://postforme.dev/auth/1",
      platform: "linkedin",
    },
  });

  await native.createConnection(
    {
      platform: "linkedin",
      externalId: "tenant-1",
      permissions: ["posts", "feeds"],
      forceReauth: true,
      platformData: { linkedin: { connectionType: "organization" } },
    },
    context,
  );

  assert.deepEqual(calls[0]?.body, {
    platform: "linkedin",
    external_id: "tenant-1",
    permissions: ["posts", "feeds"],
    force_reauth: true,
    platform_data: { linkedin: { connection_type: "organization" } },
  });
});

it("disconnects, deletes and relabels accounts", async () => {
  const x = account("x");

  const { native, calls } = fake({
    "POST /v1/social-accounts/spc_1/disconnect": {
      id: "spc_1",
      platform: "x",
      user_id: "u1",
      status: "disconnected",
      access_token: "SECRET",
    },
    "DELETE /v1/social-accounts/spc_1": { success: true },
    "PATCH /v1/social-accounts/spc_1": {
      id: "spc_1",
      platform: "x",
      user_id: "u1",
      status: "connected",
    },
  });

  const disconnected = await native.disconnectAccount({ account: x }, context);

  assert.equal(disconnected.status, "reconnect-required");
  assert.ok(!JSON.stringify(disconnected).includes("SECRET"));
  await native.deleteAccount({ account: x }, context);
  await native.updateAccount({ account: x, externalId: "tenant-2" }, context);
  assert.deepEqual(calls[2]?.body, { external_id: "tenant-2" });
});

it("reschedules a scheduled post with PUT, keeping its stored fields", async () => {
  const media = [{ url: "https://cdn.example.test/a.png" }];

  const { native, calls } = fake({
    "GET /v1/social-posts/sp_1": {
      id: "sp_1",
      status: "scheduled",
      caption: "Old",
      scheduled_at: "2026-11-10T09:00:00Z",
      media,
      social_accounts: [{ id: "spc_1", platform: "x" }],
    },
    "PUT /v1/social-posts/sp_1": { id: "sp_1", status: "scheduled" },
  });

  await native.updatePost(
    {
      delivery: {
        kind: "delivery",
        version: 1,
        backend: "default",
        platform: "x",
        accountId: "spc_1",
        deliveryId: "sp_1",
      },
      text: "New",
      at: "2026-11-12T09:00:00Z",
    },
    context,
  );

  assert.deepEqual(calls[1]?.body, {
    caption: "New",
    social_accounts: ["spc_1"],
    scheduled_at: "2026-11-12T09:00:00Z",
    isDraft: false,
    media,
  });
});

it("previews a post through social-post-previews", async () => {
  const { native, calls } = fake({
    "POST /v1/social-post-previews": [
      {
        caption: "Hi",
        platform: "tiktok",
        social_account_id: "spc_1",
        media: [{ url: "https://cdn.example.test/a.png", thumbnail_url: null }],
      },
    ],
  });

  const result = await native.previewPost(
    { account: account("tiktok"), content: { text: "Hi", media: [image("a")] } },
    context,
  );

  assert.deepEqual(result.previews, [
    {
      caption: "Hi",
      platform: "tiktok",
      social_account_id: "spc_1",
      media: ["https://cdn.example.test/a.png"],
    },
  ]);
  assert.deepEqual(calls[0]?.body, {
    caption: "Hi",
    preview_social_accounts: [{ id: "spc_1", platform: "tiktok" }],
    media: [{ url: "https://cdn.example.test/a.png" }],
  });
});

it("creates, lists, updates and deletes /v1/webhooks", async () => {
  const hook = {
    id: "wh_1",
    url: "https://app.example.com/hooks",
    secret: "pfm_secret",
    event_types: ["social.post.result.created"],
  };

  const { native, calls } = fake({
    "POST /v1/webhooks": hook,
    "GET /v1/webhooks": { data: [hook] },
    "PATCH /v1/webhooks/wh_1": { ...hook, event_types: ["social.post.updated"] },
    "DELETE /v1/webhooks/wh_1": { success: true },
  });

  const created = await native.createWebhook(
    { url: "https://app.example.com/hooks", eventTypes: ["social.post.result.created"] },
    context,
  );

  assert.equal(created.secret, "pfm_secret");
  assert.ok(!JSON.stringify(await native.listWebhooks(context)).includes("pfm_secret"));
  await native.updateWebhook({ webhookId: "wh_1", eventTypes: ["social.post.updated"] }, context);
  await native.deleteWebhook({ webhookId: "wh_1" }, context);
  assert.deepEqual(calls[2]?.body, { event_types: ["social.post.updated"] });
  assert.equal(calls[3]?.method, "DELETE");
});
