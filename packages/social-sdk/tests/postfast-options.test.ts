import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef, type PublishRequest } from "../src/index.js";
import { postfast } from "../src/cloud/postfast.js";
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

const clock = () => new Date("2026-11-04T12:00:00.000Z");

const future = "2026-11-05T09:00:00.000Z";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
}

/** A PostFast adapter whose fake fetch answers uploads, creates and reads. */
function fake(routes: Readonly<Record<string, JsonValue>> = {}) {
  const calls: Call[] = [];
  let uploads = 0;

  const adapter = postfast({
    apiKey: "test",
    clock,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (url.hostname === "s3.amazonaws.com") return new Response(null, { status: 200 });

      // Uploads PUT raw bytes; every API call sends a JSON string body.
      const parsed: unknown =
        init?.body instanceof Blob || init?.body === undefined || init.body === null
          ? undefined
          : JSON.parse(String(init.body));

      calls.push({
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        ...definedFields({ body: isJsonValue(parsed) ? parsed : undefined }),
      });

      if (url.pathname === "/file/get-signed-upload-urls") {
        uploads++;
        const contentType = String(object(isJsonValue(parsed) ? parsed : {})["contentType"]);

        const extension =
          contentType === "application/x-subrip"
            ? "srt"
            : contentType === "text/vtt"
              ? "vtt"
              : contentType.split("/")[1];

        const folder = contentType.startsWith("image/")
          ? "image"
          : contentType.startsWith("video/")
            ? "video"
            : "file";

        return Response.json([
          {
            key: `${folder}/0000000${uploads}-0000-4000-8000-000000000000.${extension}`,
            signedUrl: `https://s3.amazonaws.com/postfast-uploads/upload-${uploads}`,
          },
        ]);
      }

      const answer = routes[`${method} ${url.pathname}`];

      if (answer !== undefined) return Response.json(answer);

      if (method === "POST" && url.pathname === "/social-posts")
        return Response.json({ postIds: ["p1"] });

      if (method === "GET" && url.pathname === "/social-posts")
        return Response.json({
          data: [
            {
              id: "p1",
              status: "SCHEDULED",
              approvalStatus: "APPROVED",
              socialMediaId: url.searchParams.get("ids") === "p1" ? "sm1" : "",
              scheduledAt: future,
            },
          ],
        });

      return Response.json({ message: "no route" }, { status: 404 });
    },
  });

  return { adapter, native: adapter.native, calls };
}

const account = (platform: string) =>
  connectedAccountRef({ backend: "default", platform, accountId: "sm1" });

const bytes = (kind: "image" | "video" | "document", mimeType: string): MediaAttachment => ({
  kind,
  mimeType,
  filename: `file.${mimeType.split("/")[1]}`,
  source: {
    kind: "blob",
    blob: new Blob([new Uint8Array(4)], { type: mimeType }),
    fingerprint: kind,
  },
});

const image = bytes("image", "image/png");

const video = bytes("video", "video/mp4");

/** Publish one target through the client and return the create body PostFast received. */
async function created(request: PublishRequest): Promise<JsonObject> {
  const { adapter, calls } = fake();
  const social = createSocial({ backend: adapter, clock });

  const result = await social.posts.publish(request);

  assert.notEqual(result.outcomes[0]?.state, "failed", JSON.stringify(result.outcomes[0]));

  const create = calls.find((call) => call.method === "POST" && call.path === "/social-posts");

  return object(create?.body ?? {});
}

const controls = (body: JsonObject) => object(body["controls"] ?? {});

const post = (body: JsonObject) => object(array(body["posts"])[0]);

function codes(request: PublishRequest): readonly string[] {
  return createSocial({ backend: postfast({ apiKey: "test", clock }), clock })
    .posts.prepare(request)
    .issues.map((issue) => issue.code);
}

const tiktokChoices = {
  privacy: "PUBLIC_TO_EVERYONE",
  consentGiven: true,
  disableComments: false,
  disableDuet: false,
  disableStitch: false,
  brandedContent: false,
  ownBrand: false,
  aiGenerated: false,
  draft: false,
} as const;

it("sends firstComment on the post for X, Instagram, Facebook, YouTube, Threads and TikTok", async () => {
  const body = await created({
    targets: [{ account: account("x"), options: { firstComment: "Details at postfa.st" } }],
    content: { text: "Launch" },
    schedule: { at: future },
  });

  assert.equal(post(body)["firstComment"], "Details at postfa.st");
  assert.ok(
    codes({
      targets: [{ account: account("linkedin"), options: { firstComment: "nope" } }],
      content: { text: "LinkedIn" },
      schedule: { at: future },
    }).includes("options.unmapped"),
  );
});

it("maps YouTube youtubeTags, youtubePlaylistId, youtubeContainsSyntheticMedia, captions and a youtubeThumbnailKey", async () => {
  const body = await created({
    targets: [
      {
        account: account("youtube"),
        options: {
          title: "Tour",
          visibility: "public",
          madeForKids: false,
          tags: ["sdk", "api"],
          playlistId: "PL1",
          containsSyntheticMedia: true,
          language: "en",
          captionKey: "file/4aa995e5-fbd5-4899-91e8-c3bdae175e23.srt",
        },
      },
    ],
    content: {
      text: "Tour",
      media: [
        {
          ...video,
          thumbnail: {
            kind: "blob",
            blob: new Blob([new Uint8Array(2)], { type: "image/jpeg" }),
            fingerprint: "cover",
          },
        },
      ],
    },
    schedule: { at: future },
  });

  const sent = controls(body);

  assert.deepEqual(sent["youtubeTags"], ["sdk", "api"]);
  assert.equal(sent["youtubePlaylistId"], "PL1");
  assert.equal(sent["youtubeContainsSyntheticMedia"], true);
  assert.equal(sent["youtubeLanguage"], "en");
  assert.equal(sent["youtubeCaptionKey"], "file/4aa995e5-fbd5-4899-91e8-c3bdae175e23.srt");
  assert.match(String(sent["youtubeThumbnailKey"]), /^image\/.+\.jpeg$/);
  assert.equal(object(array(post(body)["mediaItems"])[0])["coverImageKey"], undefined);
});

it("maps TikTok tiktokTitle, tiktokAutoAddMusic, tiktokMusicSoundId and a cover timestamp", async () => {
  const photos = await created({
    targets: [
      {
        account: account("tiktok"),
        options: { ...tiktokChoices, title: "Desk setups", autoAddMusic: true },
      },
    ],
    content: { text: "Photos", media: [image, image] },
    schedule: { at: future },
  });

  assert.equal(controls(photos)["tiktokTitle"], "Desk setups");
  assert.equal(controls(photos)["tiktokAutoAddMusic"], true);

  const clip = await created({
    targets: [
      {
        account: account("tiktok"),
        options: { ...tiktokChoices, musicSoundId: "7363314838511175697", coverTimestampMs: 3000 },
      },
    ],
    content: { text: "Clip", media: [video] },
    schedule: { at: future },
  });

  assert.equal(controls(clip)["tiktokMusicSoundId"], "7363314838511175697");
  assert.equal(object(array(post(clip)["mediaItems"])[0])["coverTimestamp"], "3000");
  assert.ok(
    codes({
      targets: [
        {
          account: account("tiktok"),
          options: { ...tiktokChoices, musicSoundId: "1", autoAddMusic: true },
        },
      ],
      content: { media: [image] },
      schedule: { at: future },
    }).includes("tiktok.music"),
  );
});

it("maps Instagram instagramPublishType, instagramPostToGrid, collaborators, location, AI label and trial Reels", async () => {
  const reel = await created({
    targets: [
      {
        account: account("instagram"),
        options: {
          placement: "reels",
          shareToFeed: false,
          collaborators: ["partner"],
          locationId: "105890561436614",
          aiGenerated: true,
          trialReel: "performance",
        },
      },
    ],
    content: {
      text: "Reel",
      media: [
        {
          ...video,
          thumbnail: {
            kind: "blob",
            blob: new Blob([new Uint8Array(2)], { type: "image/png" }),
            fingerprint: "c",
          },
        },
      ],
    },
    schedule: { at: future },
  });

  assert.deepEqual(controls(reel), {
    instagramPublishType: "REEL",
    instagramCollaborators: ["partner"],
    instagramLocationId: "105890561436614",
    instagramIsAiGenerated: true,
    instagramTrialReelStrategy: "SS_PERFORMANCE",
    instagramPostToGrid: false,
  });
  assert.match(String(object(array(post(reel)["mediaItems"])[0])["coverImageKey"]), /^image\//);

  const story = await created({
    targets: [{ account: account("instagram"), options: { placement: "story" } }],
    content: { media: [image] },
    schedule: { at: future },
  });

  assert.equal(controls(story)["instagramPublishType"], "STORY");
  assert.ok(
    codes({
      targets: [
        { account: account("instagram"), options: { placement: "reels", trialReel: "manual" } },
      ],
      content: { media: [video] },
      schedule: { at: future },
    }).includes("instagram.trial_reel"),
  );
});

it("maps Facebook facebookContentType, facebookReelsCollaborators, facebookPlaceId, countries and link carousels", async () => {
  const reel = await created({
    targets: [
      { account: account("facebook"), options: { reel: true, collaborators: ["studio.page"] } },
    ],
    content: { text: "Reel", media: [video] },
    schedule: { at: future },
  });

  assert.deepEqual(controls(reel), {
    facebookContentType: "REEL",
    facebookReelsCollaborators: ["studio.page"],
  });

  const feed = await created({
    targets: [
      {
        account: account("facebook"),
        options: { locationId: "999", geoRestriction: { countries: ["US", "CA"] } },
      },
    ],
    content: { text: "Local news" },
    schedule: { at: future },
  });

  assert.deepEqual(controls(feed), {
    facebookPlaceId: "999",
    facebookTargetCountries: ["US", "CA"],
  });

  const carousel = await created({
    targets: [
      {
        account: account("facebook"),
        options: {
          carouselCards: [
            { link: "https://example.com/a", name: "Guide A" },
            { link: "https://example.com/b", description: "8 min" },
          ],
        },
      },
    ],
    content: { text: "Pick", media: [image, image] },
    schedule: { at: future },
  });

  assert.equal(controls(carousel)["facebookCarouselMainLink"], "https://example.com/a");

  const items = array(post(carousel)["mediaItems"]).map(object);

  assert.equal(items[0]?.["mediaLink"], "https://example.com/a");
  assert.equal(items[0]?.["mediaCaption"], "Guide A");
  assert.equal(items[1]?.["mediaDescription"], "8 min");
  assert.equal(controls(carousel)["facebookCarouselShowEndCard"], undefined);

  const endCard = await created({
    targets: [
      {
        account: account("facebook"),
        options: {
          carouselCards: [{ link: "https://example.com/a" }, { link: "https://example.com/b" }],
          carouselEndCard: true,
        },
      },
    ],
    content: { text: "Pick", media: [image, image] },
    schedule: { at: future },
  });

  assert.equal(controls(endCard)["facebookCarouselShowEndCard"], true);
});

it("rejects facebookCarouselShowEndCard without carousel cards", async () => {
  const { adapter } = fake({});

  const social = createSocial({ clock, backend: adapter });

  const prepared = social.posts.prepare({
    targets: [{ account: account("facebook"), options: { carouselEndCard: true } }],
    content: { text: "No cards", media: [image] },
    schedule: { at: future },
  });

  assert.equal(prepared.ok, false);
  assert.ok(prepared.issues.some((issue) => issue.code === "facebook.carousel"));
});

it("maps X xRetweetUrl and Threads threadsTopicTag", async () => {
  const repost = await created({
    targets: [
      { account: account("x"), options: { repostUrl: "https://x.com/user/status/1234567890" } },
    ],
    content: { text: "Worth a look" },
    schedule: { at: future },
  });

  assert.equal(controls(repost)["xRetweetUrl"], "https://x.com/user/status/1234567890");

  const threads = await created({
    targets: [{ account: account("threads"), options: { topicTag: "Product" } }],
    content: { text: "Update" },
    schedule: { at: future },
  });

  assert.equal(controls(threads)["threadsTopicTag"], "Product");
});

it("uploads a LinkedIn document as linkedinAttachmentKey with linkedinAttachmentTitle", async () => {
  const body = await created({
    targets: [{ account: account("linkedin"), options: { documentTitle: "Engagement 2026" } }],
    content: { text: "Our report", media: [bytes("document", "application/pdf")] },
    schedule: { at: future },
  });

  assert.match(String(controls(body)["linkedinAttachmentKey"]), /^file\/.+\.pdf$/);
  assert.equal(controls(body)["linkedinAttachmentTitle"], "Engagement 2026");
  assert.equal(post(body)["mediaItems"], undefined);
});

it("maps Google Business gbpTopicType, call to action, event and offer fields", async () => {
  const body = await created({
    targets: [
      {
        account: account("google-business"),
        options: {
          locationId: "loc1",
          topicType: "OFFER",
          eventTitle: "Winter sale",
          eventStart: "2026-12-01T00:00:00Z",
          eventEnd: "2026-12-07T00:00:00Z",
          offerCouponCode: "WINTER",
          callToActionType: "SHOP",
          callToActionUrl: "https://shop.example.com",
        },
      },
    ],
    content: { text: "20% off", media: [bytes("image", "image/jpeg")] },
    schedule: { at: future },
  });

  assert.deepEqual(controls(body), {
    gbpTopicType: "OFFER",
    gbpCallToActionType: "SHOP",
    gbpCallToActionUrl: "https://shop.example.com/",
    gbpEventTitle: "Winter sale",
    gbpEventStartDate: "2026-12-01T00:00:00Z",
    gbpEventEndDate: "2026-12-07T00:00:00Z",
    gbpOfferCouponCode: "WINTER",
    gbpLocationId: "loc1",
  });
  assert.ok(
    codes({
      targets: [
        { account: account("google-business"), options: { locationId: "l", topicType: "EVENT" } },
      ],
      content: { text: "event" },
      schedule: { at: future },
    }).includes("google_business.event"),
  );
});

it("saves a DRAFT without a time and holds a post for approval", async () => {
  const { native, calls } = fake({
    "GET /social-posts": {
      data: [{ id: "p1", status: "DRAFT", socialMediaId: "sm1", scheduledAt: null }],
    },
  });

  const draft = await native.submitPost(
    { account: account("x"), content: { text: "Draft" }, submission: { kind: "draft" } },
    context,
  );

  assert.equal(draft.state, "accepted");

  const body = object(calls.find((call) => call.method === "POST")?.body ?? {});

  assert.equal(body["status"], "DRAFT");
  assert.equal(post(body)["scheduledAt"], undefined);

  await native.submitPost(
    {
      account: account("x"),
      content: { text: "Review me" },
      schedule: { at: future },
      submission: { kind: "approval" },
    },
    context,
  );

  const approval = object(calls.filter((call) => call.method === "POST").at(-1)?.body ?? {});

  assert.equal(approval["status"], "SCHEDULED");
  assert.equal(approval["approvalStatus"], "PENDING_APPROVAL");
});

it("lists account posts with posts.list and bulk deletes", async () => {
  const { adapter, native, calls } = fake({
    "GET /social-posts": {
      data: [
        {
          id: "p1",
          socialMediaId: "sm1",
          status: "PUBLISHED",
          platformPostId: "n1",
          content: "hi",
        },
        { id: "p2", socialMediaId: "other", status: "PUBLISHED" },
      ],
      pageInfo: { hasNextPage: true, page: 1, perPage: 20 },
    },
    "POST /social-posts/bulk-delete": { deletedIds: ["p1"], notFoundIds: ["p9"] },
  });

  const page = await adapter.posts.list(account("x"), { limit: 20 }, context);

  assert.deepEqual(page, {
    items: [{ id: "p1", content: "hi", status: "PUBLISHED", platformPostId: "n1" }],
    nextCursor: "1",
  });
  assert.deepEqual(calls[0]?.query, { socialMediaIds: "sm1", page: "0", limit: "20" });
  assert.deepEqual(await native.bulkDelete({ ids: ["p1", "p9"] }, context), {
    deletedIds: ["p1"],
    notFoundIds: ["p9"],
  });
  await assert.rejects(native.bulkDelete({ ids: [] }, context), { code: "invalid_input" });
});

it("uploads caption files as application/x-subrip or text/vtt", async () => {
  const { native, calls } = fake();

  const srt = await native.uploadCaptions(
    { file: new Blob(["1\n00:00:00,000 --> 00:00:01,000\nHi\n"]), format: "srt" },
    context,
  );

  assert.match(srt.key, /^file\/.+\.srt$/);
  assert.deepEqual(calls[0]?.body, { contentType: "application/x-subrip", count: 1 });

  await native.uploadCaptions({ file: new Blob(["WEBVTT\n"]), format: "vtt" }, context);
  assert.deepEqual(calls[1]?.body, { contentType: "text/vtt", count: 1 });
});

it("reads followerCount metrics and follower-history", async () => {
  const { adapter, native } = fake({
    "GET /social-media/my-social-accounts": [
      {
        id: "sm1",
        platform: "INSTAGRAM",
        connectionStatus: "CONNECTED",
        followerCount: "1234",
        followerCountUpdatedAt: "2026-11-04",
      },
    ],
    "GET /social-media/sm1/follower-history": {
      socialMediaId: "sm1",
      currentFollowerCount: "1234",
      delta: "-12",
      series: [{ capturedAt: "2026-11-03T04:00:00Z", followerCount: "1246" }],
    },
  });

  const metrics = await adapter.analytics.getAccountMetrics(account("instagram"), context);

  assert.deepEqual(
    metrics.map((metric) => [metric.name, metric.value, metric.measuredAt]),
    [["followers", 1234, "2026-11-04"]],
  );
  assert.deepEqual(await native.followerHistory({ account: account("instagram") }, context), {
    currentFollowerCount: 1234,
    delta: -12,
    series: [{ capturedAt: "2026-11-03T04:00:00Z", followerCount: 1246 }],
  });
});

it("looks up pinterest-boards, youtube-playlists, gbp-locations, TikTok sounds and places", async () => {
  const { native, calls } = fake({
    "GET /social-media/sm1/pinterest-boards": [{ id: "b", boardId: "123", name: "Ideas" }],
    "GET /social-media/sm1/youtube-playlists": [{ id: "y", playlistId: "PL1", title: "Tours" }],
    "GET /social-media/sm1/gbp-locations": [{ id: "g", locationId: "loc1", title: "Store" }],
    "GET /social-media/sm1/tiktok-sounds": [
      { musicSoundId: "736", name: "Song", artist: "A", previewUrl: "https://p" },
    ],
    "GET /social-media/search-places": [{ id: "999", name: "Cafe", city: "Austin" }],
  });

  assert.deepEqual(await native.pinterestBoards({ account: account("pinterest") }, context), [
    { boardId: "123", name: "Ideas" },
  ]);
  assert.deepEqual(await native.youtubePlaylists({ account: account("youtube") }, context), [
    { playlistId: "PL1", title: "Tours" },
  ]);
  assert.deepEqual(await native.gbpLocations({ account: account("google-business") }, context), [
    { locationId: "loc1", title: "Store" },
  ]);
  assert.deepEqual(
    await native.tiktokSounds({ account: account("tiktok"), dateRange: "30DAY" }, context),
    [{ musicSoundId: "736", name: "Song", artist: "A" }],
  );
  assert.deepEqual(await native.searchPlaces({ query: "cafe" }, context), [
    { id: "999", name: "Cafe", city: "Austin" },
  ]);
  assert.deepEqual(calls[3]?.query, { dateRange: "30DAY" });
  await assert.rejects(native.pinterestBoards({ account: account("x") }, context), {
    code: "invalid_input",
  });
});

it("reads the Social Inbox, replies with an idempotency key, private-replies and moderates", async () => {
  const { native, calls } = fake({
    "GET /social-inbox/conversations": {
      data: [
        { id: "c1", socialMediaId: "sm1", platform: "INSTAGRAM", canReply: true, unreadCount: 2 },
        { id: "c2", socialMediaId: "other" },
      ],
    },
    "GET /social-inbox/conversations/c1/items": {
      data: [
        { id: "i1", text: "Nice", direction: "INBOUND", state: "VISIBLE", canPrivateReply: true },
      ],
    },
    "POST /social-inbox/items/i1/reply": {
      id: "i2",
      direction: "OUTBOUND",
      deliveryStatus: "SENT",
    },
    "POST /social-inbox/items/i1/private-reply": { id: "i3", direction: "OUTBOUND" },
    "POST /social-inbox/items/i1/state": { id: "i1", state: "HIDDEN" },
    "POST /social-inbox/conversations/c1/read": { id: "c1", unreadCount: 0 },
  });

  const conversations = await native.listInboxConversations(
    { account: account("instagram") },
    context,
  );

  assert.deepEqual(conversations, [
    { id: "c1", platform: "INSTAGRAM", canReply: true, unreadCount: 2 },
  ]);
  assert.equal(calls[0]?.query["statuses"], undefined);
  assert.equal(
    (await native.listInboxItems({ conversationId: "c1" }, context))[0]?.["text"],
    "Nice",
  );
  await native.replyToInboxItem({ itemId: "i1", text: "Thanks!", idempotencyKey: "k1" }, context);
  assert.deepEqual(calls[2]?.body, { text: "Thanks!", idempotencyKey: "k1" });
  await native.privateReply({ itemId: "i1", text: "Sent you a DM" }, context);
  assert.deepEqual(await native.moderateInboxItem({ itemId: "i1", action: "hide" }, context), {
    id: "i1",
    state: "HIDDEN",
  });
  assert.deepEqual(calls[4]?.body, { action: "HIDE" });
  assert.deepEqual(await native.markInboxRead({ conversationId: "c1" }, context), {
    unreadCount: 0,
  });
  await assert.rejects(native.privateReply({ itemId: "i1", text: "é".repeat(600) }, context), {
    code: "invalid_input",
  });
});

it("filters Social Inbox conversations by statuses and assignedToUserId, and orders items", async () => {
  const assignee = "0b6c3f1e-2d4a-4c8e-9f10-123456789abc";

  const { native, calls } = fake({
    "GET /social-inbox/conversations": {
      data: [
        {
          id: "c1",
          socialMediaId: "sm1",
          status: "SNOOZED",
          assignedToUserId: assignee,
          unreadCount: 1,
        },
      ],
    },
    "GET /social-inbox/conversations/c1/items": { data: [{ id: "i9", text: "Newest" }] },
  });

  const conversations = await native.listInboxConversations(
    {
      account: account("instagram"),
      statuses: ["OPEN", "SNOOZED"],
      assignedToUserId: assignee,
    },
    context,
  );

  assert.deepEqual(conversations, [
    { id: "c1", status: "SNOOZED", assignedToUserId: assignee, unreadCount: 1 },
  ]);

  assert.deepEqual(calls[0]?.query, {
    socialMediaIds: "sm1",
    page: "0",
    limit: "20",
    statuses: "OPEN,SNOOZED",
    assignedToUserId: assignee,
  });

  await native.listInboxItems({ conversationId: "c1", order: "DESC" }, context);
  assert.deepEqual(calls[1]?.query, { page: "0", limit: "20", order: "DESC" });

  await assert.rejects(
    native.listInboxConversations(
      { account: account("instagram"), assignedToUserId: "me" },
      context,
    ),
    { code: "invalid_input" },
  );
  await assert.rejects(
    native.listInboxConversations({ account: account("instagram"), statuses: [] }, context),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 2);
});

it("sets Social Inbox triage status and assignment, and refuses unconfirmed writes", async () => {
  const assignee = "c7d8e9f0-1234-5678-9abc-def012345678";

  const { native, calls } = fake({
    "POST /social-inbox/conversations/c1/status": {
      id: "c1",
      socialMediaId: "sm1",
      contactId: "contact-1",
      platform: "INSTAGRAM",
      status: "CLOSED",
      assignedToUserId: null,
      unreadCount: 0,
      participantAvatarUrl: "https://cdn.example/avatar.png",
      postPreview: { caption: "Launch" },
    },
    "POST /social-inbox/conversations/c1/assign": {
      id: "c1",
      status: "OPEN",
      assignedToUserId: assignee,
    },
    "POST /social-inbox/conversations/c2/assign": {
      id: "c2",
      status: "OPEN",
      assignedToUserId: null,
    },
    "POST /social-inbox/conversations/c3/status": { id: "c3", status: "OPEN" },
    "POST /social-inbox/conversations/c3/assign": { id: "c3", status: "OPEN" },
  });

  assert.deepEqual(
    await native.setInboxStatus({ conversationId: "c1", status: "CLOSED" }, context),
    {
      id: "c1",
      platform: "INSTAGRAM",
      status: "CLOSED",
      assignedToUserId: null,
      unreadCount: 0,
    },
  );
  assert.deepEqual(calls[0], {
    method: "POST",
    path: "/social-inbox/conversations/c1/status",
    query: {},
    body: { status: "CLOSED" },
  });

  assert.deepEqual(
    await native.assignInboxConversation(
      { conversationId: "c1", assigneeUserId: assignee },
      context,
    ),
    { id: "c1", status: "OPEN", assignedToUserId: assignee },
  );
  assert.deepEqual(calls[1], {
    method: "POST",
    path: "/social-inbox/conversations/c1/assign",
    query: {},
    body: { assigneeUserId: assignee },
  });

  assert.deepEqual(
    await native.assignInboxConversation({ conversationId: "c2", assigneeUserId: null }, context),
    { id: "c2", status: "OPEN", assignedToUserId: null },
  );
  assert.deepEqual(calls[2]?.body, {});

  await assert.rejects(
    native.setInboxStatus({ conversationId: "c3", status: "SNOOZED" }, context),
    {
      code: "ambiguous_outcome",
      retryDisposition: { kind: "reconcile-first" },
    },
  );
  await assert.rejects(
    native.assignInboxConversation({ conversationId: "c3", assigneeUserId: null }, context),
    { code: "ambiguous_outcome" },
  );
  assert.equal(calls.length, 5);

  await assert.rejects(
    native.assignInboxConversation({ conversationId: "c1", assigneeUserId: "me" }, context),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 5);
});

it("reads Instagram reelsSkipRate and TikTok favorites", async () => {
  const { adapter } = fake({
    "GET /social-posts": {
      data: [
        {
          id: "p1",
          socialMediaId: "sm1",
          status: "PUBLISHED",
          platformPostId: "n1",
          publishedAt: "2026-11-03T10:00:00Z",
        },
      ],
    },
    "GET /social-posts/analytics": {
      data: [
        {
          id: "p1",
          platformPostId: "n1",
          socialMediaId: "sm1",
          latestMetric: { likes: "10", reelsSkipRate: 12.5, extras: { favorites: "4" } },
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
      accountId: "sm1",
      postId: "n1",
      native: { backendRecordId: "p1" },
    },
    context,
  );

  assert.deepEqual(
    metrics.map((metric) => [metric.name, metric.value, metric.unit]),
    [
      ["likes", 10, "count"],
      ["reelsSkipRate", 12.5, "percentage"],
      ["favorites", 4, "count"],
    ],
  );
});
