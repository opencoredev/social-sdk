import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { facebook, facebookMention } from "../src/platforms/facebook.js";
import { decodePlatformWebhook } from "../src/server/webhooks.js";
import { isJsonValue } from "../src/transport/json.js";
import { isJsonObject } from "../src/transport/validation.js";
import type { AdapterOperationContext, JsonObject, JsonValue } from "../src/core/types.js";

// Offline contract tests for Facebook Page features beyond basic publishing. Every request
// goes to a fake fetch; nothing reaches Meta.

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const start = new Date("2026-10-24T12:00:00.000Z");

const page = connectedAccountRef({ backend: "default", platform: "facebook", accountId: "123" });

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly json: JsonObject | undefined;
  readonly form: FormData | undefined;
  readonly bytes: Blob | undefined;
}

/** Replies in order and records every request, keeping JSON, multipart, and raw bodies apart. */
function fake(responses: readonly JsonValue[], clock: () => Date = () => start) {
  const calls: Call[] = [];
  let index = 0;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const raw = init?.body;
    let json: JsonObject | undefined;

    if (!(raw instanceof FormData) && !(raw instanceof Blob) && raw !== undefined && raw !== null) {
      const parsed: unknown = JSON.parse(String(raw));

      if (isJsonValue(parsed) && isJsonObject(parsed)) json = parsed;
    }

    calls.push({
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      json,
      form: raw instanceof FormData ? raw : undefined,
      bytes: raw instanceof Blob ? raw : undefined,
    });

    const response = responses[index++];

    if (response === undefined) throw new Error("Unexpected request");

    return Response.json(response);
  };

  const adapter = facebook({ auth: { pageId: "123", accessToken: "page-token" }, fetch, clock });

  return { calls, adapter, social: createSocial({ backend: adapter, clock }) };
}

const hostedVideo = {
  kind: "video" as const,
  mimeType: "video/mp4",
  source: { kind: "https-url" as const, url: "https://cdn.example.com/clip.mp4" },
};

const issueCodes = (
  social: ReturnType<typeof fake>["social"],
  request: Parameters<ReturnType<typeof fake>["social"]["posts"]["prepare"]>[0],
) => social.posts.prepare(request).issues.map((item) => item.code);

describe("facebook feed and photo publish options", () => {
  it("sends place, tags, targeting, feed_targeting, call_to_action, feeling, and backdated_time on feed posts", async () => {
    const { calls, social } = fake([{ id: "123_1" }]);

    const result = await social.posts.publish({
      targets: [
        {
          account: page,
          options: {
            place: "110843418940484",
            tags: ["1001", "1002"],
            targeting: { ageMin: 18, geoLocations: { countries: ["US", "CA"] } },
            feedTargeting: { ageMin: 21, ageMax: 45, genders: [2], locales: [6] },
            callToAction: { type: "SIGN_UP" },
            feeling: { actionTypeId: "383634835006146", objectId: "136050896551329" },
            backdatedTime: "2024-05-01T00:00:00Z",
            backdatedTimeGranularity: "day",
          },
        },
      ],
      content: { text: "Join us", link: { url: "https://example.com/join" } },
    });

    assert.equal(result.outcomes[0]?.state, "published");
    assert.equal(calls[0]?.url.pathname, "/v27.0/123/feed");
    assert.deepEqual(calls[0]?.json, {
      message: "Join us",
      link: "https://example.com/join",
      place: "110843418940484",
      tags: "1001,1002",
      call_to_action: { type: "SIGN_UP", value: { link: "https://example.com/join" } },
      og_action_type_id: "383634835006146",
      og_object_id: "136050896551329",
      targeting: { age_min: 18, geo_locations: { countries: ["US", "CA"] } },
      feed_targeting: { age_min: 21, age_max: 45, genders: [2], locales: [6] },
      backdated_time: String(Date.parse("2024-05-01T00:00:00Z") / 1000),
      backdated_time_granularity: "day",
    });
  });

  it("publishes a link carousel through child_attachments", async () => {
    const { calls, social } = fake([{ id: "123_2" }]);

    const child = (n: number) => ({
      link: `https://example.com/p/${n}`,
      picture: `https://cdn.example.com/p/${n}.jpg`,
      name: `Product ${n}`,
    });

    await social.posts.publish({
      targets: [
        {
          account: page,
          options: { childAttachments: [child(1), child(2), child(3)], multiShareEndCard: false },
        },
      ],
      content: { text: "New arrivals", link: { url: "https://example.com/shop" } },
    });

    assert.deepEqual(calls[0]?.json?.["child_attachments"], [child(1), child(2), child(3)]);
    assert.equal(calls[0]?.json?.["multi_share_end_card"], false);
  });

  it("sends positioned tag_uid photo tags, place, and no_story on a single photo", async () => {
    const { calls, social } = fake([{ id: "9", post_id: "123_9" }]);

    await social.posts.publish({
      targets: [
        {
          account: page,
          options: {
            place: "110843418940484",
            photoTags: [
              { userId: "1001", x: 25, y: 40.5 },
              { text: "Our booth", x: 80, y: 10 },
            ],
            noStory: true,
            backdatedTime: "2025-01-02T03:04:00Z",
            backdatedTimeGranularity: "minute",
          },
        },
      ],
      content: {
        text: "Booth",
        media: [
          {
            kind: "image",
            mimeType: "image/jpeg",
            source: { kind: "https-url", url: "https://cdn.example.com/booth.jpg" },
          },
        ],
      },
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/photos");
    assert.deepEqual(calls[0]?.json, {
      url: "https://cdn.example.com/booth.jpg",
      caption: "Booth",
      place: "110843418940484",
      tags: [
        { tag_uid: "1001", x: 25, y: 40.5 },
        { tag_text: "Our booth", x: 80, y: 10 },
      ],
      no_story: true,
      backdated_time: String(Date.parse("2025-01-02T03:04:00Z") / 1000),
      backdated_time_granularity: "min",
    });
  });

  it("rejects options that do not fit the post before dispatch", () => {
    const { social } = fake([]);

    const codes = (
      options: JsonObject,
      content: Parameters<typeof social.posts.prepare>[0]["content"] = { text: "x" },
    ) => issueCodes(social, { targets: [{ account: page, options }], content });

    assert.ok(codes({ tags: ["1001"] }).includes("facebook.tags_place"));
    assert.ok(
      codes({ callToAction: { type: "SHOP_NOW" } }).includes("facebook.call_to_action_link"),
    );
    assert.ok(
      codes({ callToAction: { type: "TAP_HERE" } }).includes("facebook.options.callToAction"),
    );
    assert.ok(codes({ targeting: { ageMin: 16 } }).includes("facebook.options.targeting"));
    assert.ok(codes({ backdatedTime: "2027-01-01T00:00:00Z" }).includes("facebook.backdated_time"));
    assert.ok(codes({ title: "Video only" }).includes("facebook.option_format"));
    assert.ok(
      codes({ photoTags: [{ userId: "1", x: 120, y: 0 }] }).includes("facebook.options.photoTags"),
    );
    assert.ok(
      codes({
        childAttachments: [
          { link: "https://example.com/a", picture: "https://cdn.example.com/a.jpg" },
        ],
      }).includes("facebook.options.childAttachments"),
    );
    assert.ok(codes({ unknownThing: true }).includes("facebook.options.unmapped"));
  });
});

describe("facebook video publish options", () => {
  it("sends the video title and visibility, category, and label fields [feature:facebook.publish.video.title]", async () => {
    const { calls, social } = fake([{ id: "v1" }]);

    await social.posts.publish({
      targets: [
        {
          account: page,
          options: {
            title: "Launch recap",
            secret: true,
            embeddable: false,
            hideFromNewsfeed: true,
            contentCategory: "TECHNOLOGY",
            contentTags: ["6003139266461"],
            customLabels: ["launch", "q4"],
          },
        },
      ],
      content: { text: "Recap", media: [hostedVideo] },
    });

    assert.equal(calls[0]?.url.href, "https://graph-video.facebook.com/v27.0/123/videos");
    assert.deepEqual(calls[0]?.json, {
      file_url: "https://cdn.example.com/clip.mp4",
      description: "Recap",
      title: "Launch recap",
      secret: true,
      embeddable: false,
      hide_from_newsfeed: true,
      content_category: "TECHNOLOGY",
      content_tags: ["6003139266461"],
      custom_labels: ["launch", "q4"],
    });
  });

  it("uploads a custom thumbnail as the thumb part", async () => {
    const { calls, social } = fake([{ id: "v2" }]);
    const thumb = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });

    await social.posts.publish({
      targets: [{ account: page, options: { title: "With cover" } }],
      content: {
        media: [{ ...hostedVideo, thumbnail: { kind: "blob", blob: thumb, fingerprint: "t1" } }],
      },
    });

    const form = calls[0]?.form;

    assert.ok(form);
    assert.equal(form.get("file_url"), "https://cdn.example.com/clip.mp4");
    assert.equal(form.get("title"), "With cover");
    assert.ok(form.get("thumb") instanceof Blob);
  });

  it("uploads Blob videos through a chunked start, transfer, finish session", async () => {
    const { calls, social } = fake([
      { video_id: "v3", upload_session_id: "s1", start_offset: "0", end_offset: "4" },
      { start_offset: "4", end_offset: "6" },
      { start_offset: "6", end_offset: "6" },
      { success: true },
    ]);

    const bytes = new Blob([new Uint8Array([0, 1, 2, 3, 4, 5])], { type: "video/mp4" });

    const result = await social.posts.publish({
      targets: [{ account: page, options: { chunkedUpload: true, title: "Chunked" } }],
      content: {
        text: "Big file",
        media: [
          {
            kind: "video",
            mimeType: "video/mp4",
            filename: "big.mp4",
            source: { kind: "blob", blob: bytes, fingerprint: "big" },
          },
        ],
      },
    });

    assert.equal(result.outcomes[0]?.state, "processing");
    assert.deepEqual(calls[0]?.json, { upload_phase: "start", file_size: 6 });

    const first = calls[1]?.form;
    const second = calls[2]?.form;

    assert.equal(first?.get("upload_phase"), "transfer");
    assert.equal(first?.get("upload_session_id"), "s1");
    assert.equal(first?.get("start_offset"), "0");

    const chunk = first?.get("video_file_chunk");

    assert.ok(chunk instanceof Blob);
    assert.equal(chunk.size, 4);
    assert.equal(second?.get("start_offset"), "4");
    assert.deepEqual(calls[3]?.json, {
      upload_phase: "finish",
      upload_session_id: "s1",
      description: "Big file",
      title: "Chunked",
    });
  });

  it("crossposts another Page's video with crossposted_video_id", async () => {
    const { calls, adapter } = fake([{ id: "v4" }]);

    const outcome = await adapter.native!.crosspostVideo({
      account: page,
      videoId: "777",
      description: "Shared from our partner",
      context,
    });

    assert.equal(outcome.state, "processing");
    assert.deepEqual(calls[0]?.json, {
      crossposted_video_id: "777",
      description: "Shared from our partner",
    });
  });
});

const reelResponses = [
  { video_id: "r1", upload_url: "https://rupload.facebook.com/video-upload/v27.0/r1" },
  { success: true },
  { success: true },
];

describe("facebook Reels options", () => {
  it("uploads local Reel bytes with offset and file_size, and sends title and place [feature:facebook.publish.reels.title_place]", async () => {
    const { calls, adapter } = fake(reelResponses);
    const bytes = new Blob([new Uint8Array(8)], { type: "video/mp4" });

    const outcome = await adapter.native!.publishReel({
      account: page,
      video: bytes,
      title: "Studio tour",
      place: "110843418940484",
      isAiGenerated: true,
      description: "Behind the scenes",
      context,
    });

    assert.equal(outcome.state, "processing");

    const upload = calls[1];

    assert.equal(upload?.url.href, "https://rupload.facebook.com/video-upload/v27.0/r1");
    assert.equal(upload?.headers.get("offset"), "0");
    assert.equal(upload?.headers.get("file_size"), "8");
    assert.equal(upload?.headers.get("authorization"), "OAuth page-token");
    assert.equal(upload?.bytes?.size, 8);
    assert.deepEqual(calls[2]?.json, {
      upload_phase: "finish",
      video_id: "r1",
      video_state: "PUBLISHED",
      description: "Behind the scenes",
      title: "Studio tour",
      place: "110843418940484",
      is_ai_generated: true,
    });
  });

  it("saves a Reel as a DRAFT and reports it accepted, not published", async () => {
    const { calls, social } = fake(reelResponses);

    const result = await social.posts.publish({
      targets: [{ account: page, options: { reel: true, draft: true } }],
      content: { media: [hostedVideo] },
    });

    assert.equal(result.outcomes[0]?.state, "accepted");
    assert.equal(calls[1]?.headers.get("file_url"), "https://cdn.example.com/clip.mp4");
    assert.equal(calls[2]?.json?.["video_state"], "DRAFT");
  });

  it("invites a collaborator through /collaborators and lists invitation status", async () => {
    const { calls, adapter } = fake([
      { success: true, collaborator_id: "c9", invitation_link: "https://www.facebook.com/i/c9" },
      { data: [{ id: "456", name: "Partner Page", invite_status: "Pending" }] },
    ]);

    const invite = await adapter.native!.inviteReelCollaborator({
      account: page,
      videoId: "r1",
      collaboratorPageId: "456",
      context,
    });

    assert.deepEqual(invite, {
      collaboratorId: "c9",
      invitationLink: "https://www.facebook.com/i/c9",
    });
    assert.equal(calls[0]?.url.pathname, "/v27.0/r1/collaborators");
    assert.deepEqual(calls[0]?.json, { target_id: "456" });

    const listed = await adapter.native!.listReelCollaborators({
      account: page,
      videoId: "r1",
      context,
    });

    assert.equal(calls[1]?.method, "GET");
    assert.deepEqual(listed.items, [{ id: "456", name: "Partner Page", invite_status: "Pending" }]);
  });

  it("decodes copyright_check_information", async () => {
    const { calls, adapter } = fake([
      {
        id: "r1",
        copyright_check_information: {
          status: { status: "complete", matches_found: true },
          copyright_matches: [{ content_title: "Song", matched_segments: [] }],
        },
      },
    ]);

    const check = await adapter.native!.getReelCopyrightCheck({
      account: page,
      videoId: "r1",
      context,
    });

    assert.equal(calls[0]?.url.searchParams.get("fields"), "copyright_check_information");
    assert.deepEqual(check, {
      status: "complete",
      matchesFound: true,
      matches: [{ content_title: "Song", matched_segments: [] }],
    });
  });

  it("refuses the 31st Reel in a moving 24-hour window without a request [feature:facebook.publish.reels.rate_limit]", async () => {
    let now = start.getTime();
    const responses = Array.from({ length: 31 }, () => reelResponses).flat();
    const { calls, adapter } = fake(responses, () => new Date(now));

    for (let index = 0; index < 30; index++) {
      await adapter.native!.publishReel({
        account: page,
        videoUrl: hostedVideo.source.url,
        context,
      });
      now += 60_000;
    }

    await assert.rejects(
      adapter.native!.publishReel({ account: page, videoUrl: hostedVideo.source.url, context }),
      { code: "rate_limited" },
    );
    assert.equal(calls.length, 90);

    now = start.getTime() + 24 * 60 * 60 * 1000 + 1;

    const outcome = await adapter.native!.publishReel({
      account: page,
      videoUrl: hostedVideo.source.url,
      context,
    });

    assert.equal(outcome.state, "processing");
    assert.match(
      String(adapter.capabilities.capabilities.find((c) => c.operation === "reels.publish")?.notes),
      /30 API-published Reels per Page/,
    );
  });
});

describe("facebook schedule windows", () => {
  const at = (days: number) => new Date(start.getTime() + days * 86_400_000).toISOString();

  it("schedules Page videos up to six months ahead [feature:facebook.scheduling.video]", async () => {
    const { calls, social } = fake([{ id: "v5" }]);

    const video = (days: number) => ({
      targets: [{ account: page }],
      content: { media: [hostedVideo] },
      schedule: { at: at(days) },
    });

    assert.deepEqual(issueCodes(social, video(150)), []);
    assert.ok(issueCodes(social, video(200)).includes("facebook.schedule_window"));
    assert.ok(
      issueCodes(social, {
        targets: [{ account: page }],
        content: { text: "x" },
        schedule: { at: at(150) },
      }).includes("facebook.schedule_window"),
    );

    const result = await social.posts.publish(video(150));

    assert.equal(result.outcomes[0]?.state, "scheduled");
    assert.equal(calls[0]?.json?.["scheduled_publish_time"], String(Date.parse(at(150)) / 1000));
  });

  it("limits scheduled Reels to 29 days [feature:facebook.scheduling.reels]", async () => {
    const { adapter, social } = fake([]);

    const reel = (days: number) => ({
      targets: [{ account: page, options: { reel: true } }],
      content: { media: [hostedVideo] },
      schedule: { at: at(days) },
    });

    assert.deepEqual(issueCodes(social, reel(28)), []);
    assert.ok(issueCodes(social, reel(30)).includes("facebook.schedule_window"));

    await assert.rejects(
      adapter.native!.publishReel({
        account: page,
        videoUrl: hostedVideo.source.url,
        scheduleAt: at(30),
        context,
      }),
      { code: "invalid_input", message: /29 days/ },
    );
  });
});

describe("facebook Stories and live video", () => {
  it("publishes a photo Story from an unpublished photo through /photo_stories", async () => {
    const { calls, adapter } = fake([{ id: "p1" }, { success: true, post_id: "123_77" }]);

    const outcome = await adapter.native!.publishPhotoStory({
      account: page,
      photoUrl: "https://cdn.example.com/story.jpg",
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/photos");
    assert.deepEqual(calls[0]?.json, {
      url: "https://cdn.example.com/story.jpg",
      published: false,
    });
    assert.equal(calls[1]?.url.pathname, "/v27.0/123/photo_stories");
    assert.deepEqual(calls[1]?.json, { photo_id: "p1" });
    assert.equal(outcome.state === "published" ? outcome.post.postId : undefined, "123_77");
  });

  it("removes the staged photo when Facebook refuses the photo Story", async () => {
    const calls: string[] = [];

    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);

      if (calls.length === 1) return Response.json({ id: "p2" });

      if (calls.length === 2)
        return Response.json({ error: { code: 100, message: "Invalid photo" } }, { status: 400 });

      return Response.json({ success: true });
    };

    const fb = facebook({ auth: { pageId: "123", accessToken: "t" }, fetch, clock: () => start });

    await assert.rejects(
      fb.native!.publishPhotoStory({
        account: page,
        photoUrl: "https://cdn.example.com/s.jpg",
        context,
      }),
    );
    assert.deepEqual(calls, [
      "POST /v27.0/123/photos",
      "POST /v27.0/123/photo_stories",
      "DELETE /v27.0/p2",
    ]);
  });

  it("keeps the staged photo ID when a refused photo Story cannot be cleaned up", async () => {
    const calls: string[] = [];

    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);

      if (calls.length === 1) return Response.json({ id: "p3" });

      return Response.json({ error: { code: 100, message: "Invalid photo" } }, { status: 400 });
    };

    const fb = facebook({ auth: { pageId: "123", accessToken: "t" }, fetch, clock: () => start });

    await assert.rejects(
      fb.native!.publishPhotoStory({
        account: page,
        photoUrl: "https://cdn.example.com/s.jpg",
        context,
      }),
      { code: "upstream_failure", details: { unpublishedPhotoIds: ["p3"] } },
    );
    assert.deepEqual(calls, [
      "POST /v27.0/123/photos",
      "POST /v27.0/123/photo_stories",
      "DELETE /v27.0/p3",
    ]);
  });

  it("publishes a video Story through /video_stories start, upload, and finish", async () => {
    const { calls, adapter } = fake([
      { video_id: "vs1", upload_url: "https://rupload.facebook.com/video-upload/v27.0/vs1" },
      { success: true },
      { success: true, post_id: "123_88" },
    ]);

    const outcome = await adapter.native!.publishVideoStory({
      account: page,
      videoUrl: "https://cdn.example.com/story.mp4",
      isAiGenerated: false,
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/video_stories");
    assert.deepEqual(calls[0]?.json, { upload_phase: "start" });
    assert.equal(calls[1]?.headers.get("file_url"), "https://cdn.example.com/story.mp4");
    assert.deepEqual(calls[2]?.json, {
      upload_phase: "finish",
      video_id: "vs1",
      is_ai_generated: false,
    });
    assert.equal(outcome.state, "processing");
    assert.equal(outcome.delivery?.deliveryId, "vs1");
  });

  it("lists Page Stories from /stories with status and time filters", async () => {
    const { calls, adapter } = fake([
      {
        data: [{ post_id: "123_9", status: "PUBLISHED", media_type: "photo", media_id: "m1" }],
      },
    ]);

    const stories = await adapter.native!.listStories({
      account: page,
      status: "PUBLISHED",
      since: "2026-10-01T00:00:00Z",
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/stories");
    assert.equal(calls[0]?.url.searchParams.get("status"), "PUBLISHED");
    assert.equal(
      calls[0]?.url.searchParams.get("since"),
      String(Date.parse("2026-10-01T00:00:00Z") / 1000),
    );
    assert.deepEqual(stories.items, [
      { post_id: "123_9", status: "PUBLISHED", media_type: "photo", media_id: "m1" },
    ]);
  });

  it("creates a live video on /live_videos and ends it", async () => {
    const { calls, adapter } = fake([
      { id: "lv1", secure_stream_url: "rtmps://live-api-s.facebook.com:443/rtmp/stream-key" },
      { id: "lv1" },
    ]);

    const live = await adapter.native!.createLiveVideo({
      account: page,
      status: "LIVE_NOW",
      title: "Launch stream",
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/live_videos");
    assert.deepEqual(calls[0]?.json, { status: "LIVE_NOW", title: "Launch stream" });
    assert.deepEqual(live, {
      id: "lv1",
      secureStreamUrl: "rtmps://live-api-s.facebook.com:443/rtmp/stream-key",
    });

    await adapter.native!.endLiveVideo({ account: page, liveVideoId: "lv1", context });

    assert.equal(calls[1]?.url.pathname, "/v27.0/lv1");
    assert.deepEqual(calls[1]?.json, { end_live_video: true });
  });
});

describe("facebook post reads and edits", () => {
  it("lists scheduled posts with their publish time [feature:facebook.read.scheduled_posts]", async () => {
    const { calls, adapter } = fake([
      {
        data: [
          { id: "123_5", message: "Soon", is_published: false, scheduled_publish_time: 1793000000 },
        ],
      },
    ]);

    const scheduled = await adapter.native!.listScheduledPosts({ account: page, context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/scheduled_posts");
    assert.match(calls[0]?.url.searchParams.get("fields") ?? "", /scheduled_publish_time/);
    assert.deepEqual(scheduled.items, [
      { id: "123_5", message: "Soon", is_published: false, scheduled_publish_time: 1793000000 },
    ]);
  });

  it("edits a post message [feature:facebook.edit.post]", async () => {
    const { calls, adapter } = fake([{ success: true }]);

    await adapter.native!.updatePost({
      account: page,
      postId: "123_5",
      message: "Fixed typo",
      context,
    });

    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.url.pathname, "/v27.0/123_5");
    assert.deepEqual(calls[0]?.json, { message: "Fixed typo" });
  });

  it("pins and hides posts with is_pinned and is_hidden", async () => {
    const { calls, adapter } = fake([{ success: true }, { success: false }]);

    await adapter.native!.updatePost({
      account: page,
      postId: "123_5",
      pinned: true,
      hidden: false,
      context,
    });

    assert.deepEqual(calls[0]?.json, { is_pinned: true, is_hidden: false });

    await assert.rejects(
      adapter.native!.updatePost({ account: page, postId: "123_5", pinned: false, context }),
      { code: "ambiguous_outcome" },
    );
    await assert.rejects(adapter.native!.updatePost({ account: page, postId: "123_5", context }), {
      code: "invalid_input",
    });
  });

  it("sets and clears the AI-generated label on a post edit with is_ai_generated", async () => {
    const { calls, adapter } = fake([{ success: true }, { success: true }]);

    await adapter.native!.updatePost({
      account: page,
      postId: "123_5",
      isAiGenerated: true,
      context,
    });

    await adapter.native!.updatePost({
      account: page,
      postId: "123_5",
      message: "Edited",
      isAiGenerated: false,
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123_5");
    assert.deepEqual(calls[0]?.json, { is_ai_generated: true });
    assert.deepEqual(calls[1]?.json, { message: "Edited", is_ai_generated: false });
  });

  it("reads full_picture with a post", async () => {
    const { calls, adapter } = fake([
      { id: "123_5", message: "Hi", full_picture: "https://scontent.example.com/p.jpg" },
    ]);

    const post = await adapter.posts!.get!(
      {
        kind: "platform-post",
        version: 1,
        backend: "default",
        platform: "facebook",
        accountId: "123",
        postId: "123_5",
      },
      context,
    );

    assert.match(calls[0]?.url.searchParams.get("fields") ?? "", /full_picture/);
    assert.equal(post["full_picture"], "https://scontent.example.com/p.jpg");
  });

  it("lists Reels from /video_reels [feature:facebook.read.reels]", async () => {
    const { calls, adapter } = fake([{ data: [{ id: "r1", description: "Reel" }] }]);

    const reels = await adapter.native!.listReels({ account: page, limit: 10, context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/video_reels");
    assert.equal(calls[0]?.url.searchParams.get("limit"), "10");
    assert.deepEqual(reels.items, [{ id: "r1", description: "Reel" }]);
  });

  it("lists posts that tag the Page from /tagged and visitor posts from /visitor_posts", async () => {
    const { calls, adapter } = fake([
      { data: [{ id: "9_1", message: "Thanks @Page", from: { id: "9" } }] },
      { data: [{ id: "123_2", message: "Hello Page" }] },
    ]);

    const tagged = await adapter.native!.listTaggedPosts({ account: page, context });
    const visitors = await adapter.native!.listVisitorPosts({ account: page, context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/tagged");
    assert.equal(calls[1]?.url.pathname, "/v27.0/123/visitor_posts");
    assert.deepEqual(tagged.items, [{ id: "9_1", message: "Thanks @Page" }]);
    assert.equal(visitors.items.length, 1);
  });

  it("lists photos the Page uploaded [feature:facebook.read.page_photos_videos]", async () => {
    const { calls, adapter } = fake([{ data: [{ id: "ph1", name: "Caption" }] }]);

    const photos = await adapter.native!.listPhotos({ account: page, context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/photos");
    assert.equal(calls[0]?.url.searchParams.get("type"), "uploaded");
    assert.deepEqual(photos.items, [{ id: "ph1", name: "Caption" }]);
  });
});

describe("facebook Page management", () => {
  it("updates Page details including the website", async () => {
    const { calls, adapter } = fake([{ success: true }]);

    await adapter.native!.updatePage({
      account: page,
      about: "Open-source social tooling",
      website: "https://example.com",
      emails: ["hello@example.com"],
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123");
    assert.deepEqual(calls[0]?.json, {
      about: "Open-source social tooling",
      website: "https://example.com/",
      emails: ["hello@example.com"],
    });

    await assert.rejects(adapter.native!.updatePage({ account: page, context }), {
      code: "invalid_input",
    });
  });

  it("reads and changes Page settings through /settings", async () => {
    const { calls, adapter } = fake([
      { data: [{ setting: "USERS_CAN_MESSAGE", value: true }] },
      { success: true },
    ]);

    const settings = await adapter.native!.listPageSettings({ account: page, context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/settings");
    assert.deepEqual(settings.items, [{ setting: "USERS_CAN_MESSAGE", value: true }]);

    await adapter.native!.updatePageSetting({
      account: page,
      setting: "USERS_CAN_MESSAGE",
      value: false,
      context,
    });

    assert.deepEqual(calls[1]?.json, { option: { USERS_CAN_MESSAGE: "false" } });
  });

  it("lists Page roles with their tasks from /roles", async () => {
    const { calls, adapter } = fake([
      { data: [{ id: "u1", name: "Admin", tasks: ["MANAGE", "CREATE_CONTENT"] }] },
    ]);

    const roles = await adapter.native!.listPageRoles({ account: page, context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/roles");
    assert.deepEqual(roles.items, [
      { id: "u1", name: "Admin", tasks: ["MANAGE", "CREATE_CONTENT"] },
    ]);
  });

  it("accepts a proposed Page change by its proposal ID", async () => {
    const { calls, adapter } = fake([{ success: true }]);

    await adapter.native!.respondToChangeProposal({
      account: page,
      proposalId: "555",
      accept: true,
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/555");
    assert.deepEqual(calls[0]?.json, { accept: true });
  });

  it("lists ratings and reviews from /ratings without reviewer identities", async () => {
    const { calls, adapter } = fake([
      {
        data: [
          {
            created_time: "2026-10-01T00:00:00+0000",
            recommendation_type: "positive",
            review_text: "Great support",
            reviewer: { id: "9", name: "Private Person" },
          },
        ],
      },
    ]);

    const ratings = await adapter.native!.listRatings({ account: page, context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/ratings");
    assert.deepEqual(ratings.items, [
      {
        created_time: "2026-10-01T00:00:00+0000",
        recommendation_type: "positive",
        review_text: "Great support",
      },
    ]);
  });

  it("searches Pages through /pages/search", async () => {
    const { calls, adapter } = fake([
      { data: [{ id: "110843418940484", name: "Lisbon", location: { city: "Lisbon" } }] },
    ]);

    const found = await adapter.native!.searchPages({ account: page, query: "Lisbon", context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/pages/search");
    assert.equal(calls[0]?.url.searchParams.get("q"), "Lisbon");
    assert.deepEqual(found.items, [
      { id: "110843418940484", name: "Lisbon", location: { city: "Lisbon" } },
    ]);
  });

  it("blocks a person through /blocked and treats an unconfirmed answer as ambiguous", async () => {
    const { calls, adapter } = fake([{ "9876": true }, {}]);

    await adapter.native!.blockUser({ account: page, userId: "9876", context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/blocked");
    assert.deepEqual(calls[0]?.json, { user: "9876" });
    await assert.rejects(adapter.native!.blockUser({ account: page, userId: "9876", context }), {
      code: "ambiguous_outcome",
    });
  });

  it("subscribes the app to Page webhook fields through /subscribed_apps", async () => {
    const { calls, adapter } = fake([
      { success: true },
      { data: [{ id: "app1", name: "Our app", subscribed_fields: ["feed", "messages"] }] },
    ]);

    await adapter.native!.subscribeApp({ account: page, fields: ["feed", "messages"], context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/subscribed_apps");
    assert.deepEqual(calls[0]?.json, { subscribed_fields: "feed,messages" });

    const apps = await adapter.native!.listSubscribedApps({ account: page, context });

    assert.deepEqual(apps.items, [
      { id: "app1", name: "Our app", subscribed_fields: ["feed", "messages"] },
    ]);
  });
});

describe("facebook Page list edges", () => {
  it("forwards cursor and limit to /settings and /subscribed_apps", async () => {
    const { calls, adapter } = fake([
      { data: [], paging: { cursors: { after: "s2" }, next: "https://graph.facebook.com/next" } },
      { data: [], paging: { cursors: { after: "a2" }, next: "https://graph.facebook.com/next" } },
    ]);

    const settings = await adapter.native!.listPageSettings({
      account: page,
      cursor: "s1",
      limit: 10,
      context,
    });

    const apps = await adapter.native!.listSubscribedApps({
      account: page,
      cursor: "a1",
      limit: 5,
      context,
    });

    assert.equal(calls[0]?.url.searchParams.get("after"), "s1");
    assert.equal(calls[0]?.url.searchParams.get("limit"), "10");
    assert.equal(calls[1]?.url.searchParams.get("after"), "a1");
    assert.equal(calls[1]?.url.searchParams.get("limit"), "5");
    assert.equal(settings.nextCursor, "s2");
    assert.equal(apps.nextCursor, "a2");

    await assert.rejects(adapter.native!.listSubscribedApps({ account: page, limit: 0, context }), {
      code: "invalid_input",
    });
    assert.equal(calls.length, 2);
  });
});

describe("facebook comments and reactions", () => {
  it("reads the comment stream with commenters and a total_count summary", async () => {
    const { calls, adapter } = fake([
      {
        data: [{ id: "c1", message: "Hi", from: { id: "9", name: "Ana" }, parent: { id: "c0" } }],
        summary: { total_count: 12, order: "chronological" },
      },
    ]);

    const comments = await adapter.native!.listComments({
      account: page,
      objectId: "123_1",
      filter: "stream",
      summary: true,
      context,
    });

    assert.equal(calls[0]?.url.searchParams.get("filter"), "stream");
    assert.equal(calls[0]?.url.searchParams.get("summary"), "true");
    assert.equal(comments.totalCount, 12);
    assert.deepEqual(comments.items[0]?.["from"], { id: "9", name: "Ana" });
    assert.equal(comments.items[0]?.["parentId"], "c0");
  });

  it("comments with an image attachment_url or a GIF attachment_share_url", async () => {
    const { calls, adapter } = fake([{ id: "c2" }, { id: "c3" }]);

    const created = await adapter.native!.createComment({
      account: page,
      objectId: "123_1",
      message: "See this",
      attachmentUrl: "https://cdn.example.com/a.png",
      context,
    });

    assert.deepEqual(created, { id: "c2" });
    assert.equal(calls[0]?.url.pathname, "/v27.0/123_1/comments");
    assert.deepEqual(calls[0]?.json, {
      message: "See this",
      attachment_url: "https://cdn.example.com/a.png",
    });

    await adapter.native!.createComment({
      account: page,
      objectId: "c1",
      attachmentShareUrl: "https://media.example.com/party.gif",
      context,
    });

    assert.deepEqual(calls[1]?.json, {
      attachment_share_url: "https://media.example.com/party.gif",
    });

    await assert.rejects(
      adapter.native!.createComment({
        account: page,
        objectId: "c1",
        attachmentUrl: "https://cdn.example.com/a.png",
        attachmentId: "42",
        context,
      }),
      { code: "invalid_input" },
    );
  });

  it("builds @[id] mention text for replies [feature:facebook.comments.mentions]", async () => {
    const { calls, adapter } = fake([{ id: "c4" }]);

    assert.equal(facebookMention(["9"]), "@[9]");
    assert.equal(facebookMention(["9", "10"]), "@[9,10]");
    assert.throws(() => facebookMention(["ana"]), { code: "invalid_input" });

    await adapter.native!.createComment({
      account: page,
      objectId: "c1",
      message: `${facebookMention(["9"])} thanks for asking!`,
      context,
    });

    assert.deepEqual(calls[0]?.json, { message: "@[9] thanks for asking!" });
  });

  it("edits a comment through POST /{comment-id} [feature:facebook.comments.edit]", async () => {
    const { calls, adapter } = fake([{ success: true }, { success: false }]);

    await adapter.native!.editComment({
      account: page,
      commentId: "c1",
      message: "Edited",
      context,
    });

    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.url.pathname, "/v27.0/c1");
    assert.deepEqual(calls[0]?.json, { message: "Edited" });

    await assert.rejects(
      adapter.native!.editComment({ account: page, commentId: "c1", message: "Again", context }),
      { code: "ambiguous_outcome" },
    );
  });

  it("counts reactions by type with one summary read per type [feature:facebook.engagement.reactions_read]", async () => {
    const { calls, adapter } = fake([
      { data: [], summary: { total_count: 40 } },
      { data: [], summary: { total_count: 7 } },
    ]);

    const counts = await adapter.native!.getReactionCounts({
      account: page,
      objectId: "123_1",
      types: ["LIKE", "LOVE"],
      context,
    });

    assert.equal(calls.length, 2);

    for (const [index, type] of ["LIKE", "LOVE"].entries()) {
      const url = calls[index]?.url;

      assert.equal(calls[index]?.method, "GET");
      assert.equal(url?.pathname, "/v27.0/123_1/reactions");
      assert.equal(url?.searchParams.get("type"), type);
      assert.equal(url?.searchParams.get("limit"), "0");
      assert.equal(url?.searchParams.get("summary"), "total_count");
      assert.equal(url?.searchParams.has("fields"), false);
    }

    assert.deepEqual(counts, { LIKE: 40, LOVE: 7 });
  });

  it("omits a reaction type whose summary has no count", async () => {
    const { adapter } = fake([{ data: [], summary: { total_count: 3 } }, { data: [] }]);

    const counts = await adapter.native!.getReactionCounts({
      account: page,
      objectId: "123_1",
      types: ["WOW", "HAHA"],
      context,
    });

    assert.deepEqual(counts, { WOW: 3 });
  });
});

describe("facebook Messenger", () => {
  const conversation = {
    kind: "conversation" as const,
    version: 1 as const,
    backend: "default",
    platform: "facebook",
    accountId: "123",
    conversationId: "t_1",
  };

  it("lists Messenger conversations from /conversations and their messages", async () => {
    const { calls, social } = fake([
      {
        data: [
          {
            id: "t_1",
            updated_time: "2026-10-24T11:00:00+0000",
            participants: {
              data: [
                { id: "123", name: "Page" },
                { id: "9", name: "Ana", email: "a@x" },
              ],
            },
          },
        ],
        paging: { cursors: { after: "n" }, next: "https://graph.facebook.com/next" },
      },
      {
        id: "t_1",
        messages: {
          data: [
            {
              id: "m1",
              message: "Hi",
              created_time: "2026-10-24T11:00:00+0000",
              from: { id: "9", name: "Ana" },
            },
          ],
        },
      },
    ]);

    const conversations = await social.messages.listConversations(page, { limit: 10 });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/conversations");
    assert.equal(calls[0]?.url.searchParams.get("platform"), "messenger");
    // The client wraps the Graph cursor in its own opaque cursor.
    assert.ok(conversations.nextCursor);
    assert.deepEqual(conversations.items[0]?.["participants"], [
      { id: "123", name: "Page" },
      { id: "9", name: "Ana" },
    ]);

    const messages = await social.messages.listMessages(conversation, { limit: 5 });

    assert.equal(
      calls[1]?.url.searchParams.get("fields"),
      "messages.limit(5){id,message,created_time,from,to}",
    );
    assert.equal(messages.items[0]?.text, "Hi");
    assert.equal(messages.items[0]?.authorId, "9");
  });

  it("replies in a conversation with messaging_type RESPONSE to its one other participant", async () => {
    const { calls, social } = fake([
      { participants: { data: [{ id: "123" }, { id: "9" }] } },
      { recipient_id: "9", message_id: "mid.1" },
    ]);

    const sent = await social.messages.send(conversation, { text: "Thanks for writing" });

    assert.equal(calls[1]?.url.pathname, "/v27.0/123/messages");
    assert.deepEqual(calls[1]?.json, {
      recipient: { id: "9" },
      messaging_type: "RESPONSE",
      message: { text: "Thanks for writing" },
    });
    assert.deepEqual(sent, { id: "mid.1", recipientId: "9" });
  });

  it("sends a HUMAN_AGENT tagged message with a reusable image attachment", async () => {
    const { calls, adapter } = fake([
      { recipient_id: "9", message_id: "mid.2", attachment_id: "att1" },
    ]);

    const sent = await adapter.native!.sendMessage({
      account: page,
      recipientId: "9",
      messagingType: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
      attachment: { type: "image", url: "https://cdn.example.com/receipt.png", isReusable: true },
      context,
    });

    assert.deepEqual(calls[0]?.json, {
      recipient: { id: "9" },
      messaging_type: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
      message: {
        attachment: {
          type: "image",
          payload: { url: "https://cdn.example.com/receipt.png", is_reusable: true },
        },
      },
    });
    assert.deepEqual(sent, { messageId: "mid.2", recipientId: "9", attachmentId: "att1" });
  });

  it("reuses an attachment ID and refuses a send without a message ID", async () => {
    const { calls, adapter } = fake([{ recipient_id: "9" }]);

    await assert.rejects(
      adapter.native!.sendMessage({
        account: page,
        recipientId: "9",
        messagingType: "UPDATE",
        attachment: { type: "file", attachmentId: "att1" },
        context,
      }),
      { code: "ambiguous_outcome" },
    );
    assert.deepEqual(calls[0]?.json?.["message"], {
      attachment: { type: "file", payload: { attachment_id: "att1" } },
    });
  });

  it("sends a private reply to a comment with recipient.comment_id", async () => {
    const { calls, adapter } = fake([{ recipient_id: "9", message_id: "mid.3" }]);

    const sent = await adapter.native!.privateReply({
      account: page,
      commentId: "123_1_c1",
      text: "We sent you the details privately.",
      context,
    });

    assert.deepEqual(calls[0]?.json, {
      recipient: { comment_id: "123_1_c1" },
      message: { text: "We sent you the details privately." },
    });
    assert.equal(sent.messageId, "mid.3");
  });
});

describe("facebook Insights", () => {
  it("reads post Insights by metric [feature:facebook.analytics.post_insights]", async () => {
    const { calls, adapter } = fake([
      {
        data: [
          { name: "post_media_view", period: "lifetime", values: [{ value: 1200 }] },
          {
            name: "post_reactions_by_type_total",
            period: "lifetime",
            values: [{ value: { like: 30, love: 4 } }],
          },
        ],
      },
    ]);

    const series = await adapter.native!.getPostInsights({
      account: page,
      postId: "123_1",
      metrics: ["post_media_view", "post_reactions_by_type_total"],
      period: "lifetime",
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123_1/insights");
    assert.equal(
      calls[0]?.url.searchParams.get("metric"),
      "post_media_view,post_reactions_by_type_total",
    );
    assert.equal(calls[0]?.url.searchParams.get("period"), "lifetime");
    assert.deepEqual(series, [
      { name: "post_media_view", period: "lifetime", values: [{ value: 1200 }] },
      {
        name: "post_reactions_by_type_total",
        period: "lifetime",
        values: [{ value: { like: 30, love: 4 } }],
      },
    ]);
  });

  it("reads Page Insights for days_28 by date_preset and total_over_range by range [feature:facebook.analytics.page_insights]", async () => {
    const { calls, adapter } = fake([
      {
        data: [
          {
            name: "page_media_view",
            period: "days_28",
            values: [{ value: 5400, end_time: "2026-10-24T07:00:00+0000" }],
          },
        ],
      },
      { data: [{ name: "page_follows", period: "total_over_range", values: [{ value: 88 }] }] },
    ]);

    const preset = await adapter.native!.getPageInsights({
      account: page,
      metrics: ["page_media_view"],
      period: "days_28",
      datePreset: "last_28d",
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/insights");
    assert.equal(calls[0]?.url.searchParams.get("period"), "days_28");
    assert.equal(calls[0]?.url.searchParams.get("date_preset"), "last_28d");
    assert.deepEqual(preset[0]?.values, [{ value: 5400, endTime: "2026-10-24T07:00:00+0000" }]);

    await adapter.native!.getPageInsights({
      account: page,
      metrics: ["page_follows"],
      period: "total_over_range",
      since: "2026-09-01T00:00:00Z",
      until: "2026-10-01T00:00:00Z",
      context,
    });

    assert.equal(
      calls[1]?.url.searchParams.get("since"),
      String(Date.parse("2026-09-01T00:00:00Z") / 1000),
    );

    await assert.rejects(
      adapter.native!.getPageInsights({
        account: page,
        metrics: ["page_follows"],
        period: "day",
        since: "2026-01-01T00:00:00Z",
        until: "2026-10-01T00:00:00Z",
        context,
      }),
      { code: "invalid_input" },
    );
  });
});

describe("facebook webhook fields", () => {
  const decode = (payload: JsonObject) =>
    decodePlatformWebhook({
      platform: "facebook",
      backend: "default",
      body: new TextEncoder().encode(JSON.stringify(payload)),
    });

  const change = (field: string, value: JsonObject) => ({
    object: "page",
    entry: [{ id: "123", time: 1, changes: [{ field, value }] }],
  });

  it("names feed reactions, edits, and shares by item and verb [feature:facebook.webhooks.feed]", async () => {
    const reaction = await decode(
      change("feed", { item: "reaction", verb: "add", reaction_type: "love" }),
    );

    const edited = await decode(
      change("feed", { item: "status", verb: "edited", post_id: "123_1" }),
    );

    const shareRemoved = await decode(
      change("feed", { item: "share", verb: "remove", post_id: "123_2" }),
    );

    const comment = await decode(change("feed", { item: "comment", verb: "add" }));

    assert.deepEqual([reaction.type, reaction.originalType], ["unknown", "feed.reaction.add"]);
    assert.deepEqual([edited.type, edited.originalType], ["unknown", "feed.status.edited"]);
    assert.deepEqual(
      [shareRemoved.type, shareRemoved.originalType],
      ["post.removed", "feed.share.remove"],
    );
    assert.deepEqual(
      [comment.type, comment.originalType],
      ["comment.received", "feed.comment.add"],
    );

    const odd = await decode(change("feed", { item: "status", verb: "explode" }));

    assert.equal(odd.originalType, "feed");
  });

  it("names Messenger message_reads, message_deliveries, and postbacks [feature:facebook.webhooks.messages]", async () => {
    const event = await decode({
      object: "page",
      entry: [
        {
          id: "123",
          time: 1,
          messaging: [
            { sender: { id: "9" }, recipient: { id: "123" }, read: { watermark: 1 } },
            { sender: { id: "9" }, recipient: { id: "123" }, delivery: { watermark: 1 } },
            { sender: { id: "9" }, recipient: { id: "123" }, postback: { payload: "START" } },
          ],
        },
      ],
    });

    assert.equal(event.type, "unknown");
    assert.equal(event.originalType, "message_reads,message_deliveries,messaging_postbacks");
  });

  it("decodes mention and ratings changes and proposed Page changes [feature:facebook.webhooks.other_fields]", async () => {
    const mention = await decode(
      change("mention", { item: "comment", verb: "add", post_id: "9_1" }),
    );

    const rating = await decode(
      change("ratings", { item: "rating", verb: "add", recommendation_type: "positive" }),
    );

    const proposal = await decode(
      change("page_change_proposal", { id: "555", proposed_value: "x" }),
    );

    const live = await decode(change("live_videos", { id: "lv1", status: "live" }));

    assert.equal(mention.originalType, "mention.comment.add");
    assert.equal(rating.originalType, "ratings.rating.add");
    assert.deepEqual(
      [proposal.type, proposal.originalType],
      ["account.updated", "page_change_proposal"],
    );
    assert.deepEqual([live.type, live.originalType], ["unknown", "live_videos"]);
  });
});
