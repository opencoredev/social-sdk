import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { facebook, facebookReelInsightMetrics } from "../src/platforms/facebook.js";
import { isJsonValue } from "../src/transport/json.js";
import { isJsonObject } from "../src/transport/validation.js";
import type { AdapterOperationContext, JsonObject, JsonValue } from "../src/core/types.js";

// Offline contract tests for Facebook video, photo album, live video, and video Insights
// features. Every request goes to a fake fetch; nothing reaches Meta.

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
  readonly json: JsonObject | undefined;
  readonly form: FormData | undefined;
}

function fake(responses: readonly JsonValue[]) {
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
      json,
      form: raw instanceof FormData ? raw : undefined,
    });

    const response = responses[index++];

    if (response === undefined) throw new Error("Unexpected request");

    return Response.json(response);
  };

  const clock = () => start;
  const adapter = facebook({ auth: { pageId: "123", accessToken: "page-token" }, fetch, clock });
  const { native } = adapter;

  if (!native) throw new Error("The Facebook adapter has no native module");

  return { calls, native, social: createSocial({ backend: adapter, clock }) };
}

const hostedVideo = {
  kind: "video" as const,
  mimeType: "video/mp4",
  source: { kind: "https-url" as const, url: "https://cdn.example.com/clip.mp4" },
};

const hostedPhoto = {
  kind: "image" as const,
  mimeType: "image/jpeg",
  source: { kind: "https-url" as const, url: "https://cdn.example.com/pano.jpg" },
};

describe("facebook video upload options", () => {
  it("sends per-language descriptions as multilingual_data [feature:facebook.publish.video.multilingual]", async () => {
    const { calls, social } = fake([{ id: "v1" }]);

    await social.posts.publish({
      targets: [
        {
          account: page,
          options: {
            multilingual: [
              { locale: "es_LA", text: "Nuestro lanzamiento" },
              { locale: "fr_FR", text: "Notre lancement" },
            ],
          },
        },
      ],
      content: { text: "Our launch", media: [hostedVideo] },
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/videos");
    assert.deepEqual(calls[0]?.json?.["multilingual_data"], [
      { multilingual_status_lang: "es_LA", multilingual_status: "Nuestro lanzamiento" },
      { multilingual_status_lang: "fr_FR", multilingual_status: "Notre lancement" },
    ]);
  });

  it("replaces an existing video's file with replace_video_id and swap_mode [feature:facebook.publish.video.replace]", async () => {
    const { calls, social } = fake([{ id: "v2" }]);

    await social.posts.publish({
      targets: [{ account: page, options: { replaceVideoId: "987" } }],
      content: { text: "Fixed cut", media: [hostedVideo] },
    });

    assert.equal(calls[0]?.json?.["replace_video_id"], "987");
    assert.equal(calls[0]?.json?.["swap_mode"], "replace");
  });

  it("sets an expiration time and type, and refuses a past one [feature:facebook.publish.video.expiration]", async () => {
    const { calls, social } = fake([{ id: "v3" }]);

    await social.posts.publish({
      targets: [
        {
          account: page,
          options: { expiration: { at: "2026-12-01T00:00:00Z", type: "expire_only" } },
        },
      ],
      content: { text: "Limited", media: [hostedVideo] },
    });

    assert.deepEqual(calls[0]?.json?.["expiration"], {
      time: String(Date.parse("2026-12-01T00:00:00Z") / 1000),
      type: "expire_only",
    });

    const issues = social.posts.prepare({
      targets: [
        {
          account: page,
          options: { expiration: { at: "2026-01-01T00:00:00Z", type: "expire_and_delete" } },
        },
      ],
      content: { text: "Old", media: [hostedVideo] },
    }).issues;

    assert.ok(issues.some((issue) => issue.code === "facebook.expiration"));
  });

  it("tags a sponsor on photos and videos [feature:facebook.publish.branded_content]", async () => {
    const { calls, social } = fake([{ id: "v4" }, { id: "p4", post_id: "123_4" }]);

    await social.posts.publish({
      targets: [{ account: page, options: { sponsorId: "555", sponsorRelationship: 1 } }],
      content: { text: "With our partner", media: [hostedVideo] },
    });

    await social.posts.publish({
      targets: [{ account: page, options: { sponsorId: "555" } }],
      content: { text: "Partner photo", media: [hostedPhoto] },
    });

    assert.equal(calls[0]?.json?.["sponsor_id"], "555");
    assert.equal(calls[0]?.json?.["sponsor_relationship"], 1);
    assert.equal(calls[1]?.url.pathname, "/v27.0/123/photos");
    assert.equal(calls[1]?.json?.["sponsor_id"], "555");
  });

  it("sends 360 photo and video parameters [feature:facebook.publish.spherical]", async () => {
    const { calls, social } = fake([{ id: "p5", post_id: "123_5" }, { id: "v5" }]);

    await social.posts.publish({
      targets: [
        {
          account: page,
          options: {
            allowSphericalPhoto: true,
            sphericalMetadata: { ProjectionType: "equirectangular" },
          },
        },
      ],
      content: { text: "Panorama", media: [hostedPhoto] },
    });

    await social.posts.publish({
      targets: [
        {
          account: page,
          options: {
            sphericalVideo: {
              initialHeading: 90,
              initialPitch: -10,
              fov: 70,
              projection: "equirectangular",
            },
          },
        },
      ],
      content: { text: "360 tour", media: [hostedVideo] },
    });

    assert.equal(calls[0]?.json?.["allow_spherical_photo"], true);
    assert.deepEqual(calls[0]?.json?.["spherical_metadata"], { ProjectionType: "equirectangular" });
    assert.equal(calls[1]?.json?.["spherical"], true);
    assert.equal(calls[1]?.json?.["initial_heading"], 90);
    assert.equal(calls[1]?.json?.["initial_pitch"], -10);
    assert.equal(calls[1]?.json?.["fov"], 70);
    assert.equal(calls[1]?.json?.["original_projection_type"], "equirectangular");
  });
});

describe("facebook video thumbnails and captions", () => {
  it("lists thumbnails and uploads a preferred one [feature:facebook.publish.video.thumbnails]", async () => {
    const { calls, native } = fake([
      { data: [{ id: "t1", uri: "https://cdn.example.com/t1.jpg", is_preferred: true }] },
      { success: true },
    ]);

    const thumbnails = await native.listVideoThumbnails({ account: page, videoId: "v1", context });

    await native.addVideoThumbnail({
      account: page,
      videoId: "v1",
      image: new Blob(["jpg"], { type: "image/jpeg" }),
      isPreferred: true,
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/v1/thumbnails");
    assert.deepEqual(thumbnails, [
      { id: "t1", uri: "https://cdn.example.com/t1.jpg", is_preferred: true },
    ]);
    assert.ok(calls[1]?.form?.get("source") instanceof Blob);
    assert.equal(calls[1]?.form?.get("is_preferred"), "true");
  });

  it("uploads an SRT file named by locale and manages caption locales [feature:facebook.publish.video.captions]", async () => {
    const { calls, native } = fake([
      { success: true },
      { data: [{ locale_name: "English (US)", is_default: true }] },
    ]);

    await native.updateVideoCaptions({
      account: page,
      videoId: "v1",
      captions: { file: new Blob(["1\n00:00:00,000 --> 00:00:01,000\nHi\n"]), locale: "en_US" },
      defaultLocale: "en_US",
      localesToDelete: ["fr_FR"],
      context,
    });

    const tracks = await native.listVideoCaptions({ account: page, videoId: "v1", context });
    const file = calls[0]?.form?.get("captions_file");

    assert.equal(calls[0]?.url.pathname, "/v27.0/v1/captions");
    assert.ok(file instanceof File);
    assert.equal(file.name, "captions.en_US.srt");
    assert.equal(calls[0]?.form?.get("default_locale"), "en_US");
    assert.equal(calls[0]?.form?.get("locales_to_delete"), JSON.stringify(["fr_FR"]));
    assert.deepEqual(tracks, [{ locale_name: "English (US)", is_default: true }]);
  });
});

describe("facebook photo albums", () => {
  it("uploads a photo into an album and reads albums and their photos [feature:facebook.publish.photo.album]", async () => {
    const { calls, native, social } = fake([
      { id: "p6" },
      { data: [{ id: "4041", name: "Events", count: 12 }] },
      { id: "4041", name: "Events", count: 12, can_upload: true },
      { data: [{ id: "p6", created_time: "2026-11-01T00:00:00+0000" }] },
    ]);

    await social.posts.publish({
      targets: [{ account: page, options: { albumId: "4041" } }],
      content: { text: "Launch night", media: [hostedPhoto] },
    });

    const albums = await native.listAlbums({ account: page, context });
    const album = await native.getAlbum({ account: page, albumId: "4041", context });
    const photos = await native.listAlbumPhotos({ account: page, albumId: "4041", context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/4041/photos");
    assert.equal(calls[1]?.url.pathname, "/v27.0/123/albums");
    assert.equal(albums.items[0]?.["name"], "Events");
    assert.equal(album["can_upload"], true);
    assert.equal(calls[3]?.url.pathname, "/v27.0/4041/photos");
    assert.equal(photos.items[0]?.["id"], "p6");
  });

  it("refuses an album target for a scheduled photo [feature:facebook.publish.photo.album]", () => {
    const { social } = fake([]);

    const issues = social.posts.prepare({
      targets: [{ account: page, options: { albumId: "4041" } }],
      content: { text: "Later", media: [hostedPhoto] },
      schedule: { at: "2026-10-30T12:00:00Z" },
    }).issues;

    assert.ok(issues.some((issue) => issue.code === "facebook.album_photo"));
  });
});

describe("facebook live video", () => {
  it("schedules a broadcast with event_params and cancels it [feature:facebook.publish.live.scheduled]", async () => {
    const { calls, native } = fake([
      { id: "lv1", secure_stream_url: "rtmps://live-api-s.facebook.com:443/rtmp/KEY" },
      { success: true },
      { data: [{ id: "lv1", status: "SCHEDULED_UNPUBLISHED", planned_start_time: "2026-11-01" }] },
    ]);

    const live = await native.createLiveVideo({
      account: page,
      status: "SCHEDULED_UNPUBLISHED",
      startAt: "2026-11-01T18:00:00Z",
      title: "Launch stream",
      context,
    });

    await native.updateLiveVideo({
      account: page,
      liveVideoId: "lv1",
      status: "SCHEDULED_CANCELED",
      context,
    });

    const listed = await native.listLiveVideos({ account: page, context });

    assert.equal(live.id, "lv1");
    assert.deepEqual(calls[0]?.json, {
      status: "SCHEDULED_UNPUBLISHED",
      title: "Launch stream",
      event_params: { start_time: Date.parse("2026-11-01T18:00:00Z") / 1000 },
    });
    assert.equal(calls[1]?.url.pathname, "/v27.0/lv1");
    assert.deepEqual(calls[1]?.json, { status: "SCHEDULED_CANCELED" });
    assert.match(calls[2]?.url.searchParams.get("fields") ?? "", /planned_start_time/);
    assert.equal(listed.items[0]?.["planned_start_time"], "2026-11-01");
  });

  it("refuses a scheduled status without a future start [feature:facebook.publish.live.scheduled]", async () => {
    const { calls, native } = fake([]);

    await assert.rejects(
      native.createLiveVideo({
        account: page,
        status: "SCHEDULED_LIVE",
        startAt: "2026-01-01T00:00:00Z",
        context,
      }),
      /future ISO time/,
    );

    assert.equal(calls.length, 0);
  });

  it("reads status and ingest_streams health without stream keys, and deletes [feature:facebook.read.live]", async () => {
    const { calls, native } = fake([
      {
        id: "lv1",
        status: "LIVE",
        ingest_streams: [
          {
            id: "is1",
            stream_id: "0",
            is_master: true,
            stream_url: "rtmp://rtmp-api.facebook.com/rtmp/SECRET",
            secure_stream_url: "rtmps://rtmp-api.facebook.com/rtmp/SECRET",
            stream_health: { video_bitrate: 4024116, video_framerate: 60 },
          },
        ],
      },
      { success: true },
    ]);

    const live = await native.getLiveVideo({ account: page, liveVideoId: "lv1", context });

    await native.deleteLiveVideo({ account: page, liveVideoId: "lv1", context });

    assert.match(calls[0]?.url.searchParams.get("fields") ?? "", /ingest_streams/);
    assert.equal(live["status"], "LIVE");
    assert.deepEqual(live["ingest_streams"], [
      {
        id: "is1",
        stream_id: "0",
        is_master: true,
        stream_health: { video_bitrate: 4024116, video_framerate: 60 },
      },
    ]);
    assert.doesNotMatch(JSON.stringify(live), /SECRET/);
    assert.equal(calls[1]?.method, "DELETE");
    assert.equal(calls[1]?.url.pathname, "/v27.0/lv1");
  });

  it("sends backup ingest, stop-on-delete, tags, targeting, crossposting, and 360 options [feature:facebook.publish.live.options]", async () => {
    const { calls, native } = fake([{ id: "lv2" }]);

    await native.createLiveVideo({
      account: page,
      status: "LIVE_NOW",
      enableBackupIngest: true,
      stopOnDeleteStream: false,
      contentTags: ["6003139266461"],
      targeting: { ageMin: 18 },
      crosspostingActions: [{ pageId: "456", action: "enable_crossposting" }],
      isSpherical: true,
      projection: "CUBEMAP",
      context,
    });

    assert.deepEqual(calls[0]?.json, {
      status: "LIVE_NOW",
      enable_backup_ingest: true,
      stop_on_delete_stream: false,
      content_tags: ["6003139266461"],
      targeting: { age_min: 18 },
      crossposting_actions: [{ page_id: "456", action: "enable_crossposting" }],
      is_spherical: true,
      projection: "CUBEMAP",
    });
  });

  it("creates a live poll and opens voting [feature:facebook.publish.live.polls]", async () => {
    const { calls, native } = fake([{ id: "poll1" }, { success: true }]);

    const poll = await native.createLivePoll({
      account: page,
      liveVideoId: "lv1",
      question: "Which feature next?",
      options: ["Themes", "Exports"],
      showResults: true,
      context,
    });

    await native.updateLivePoll({ account: page, pollId: "poll1", action: "SHOW_VOTING", context });

    assert.deepEqual(poll, { id: "poll1" });
    assert.equal(calls[0]?.url.pathname, "/v27.0/lv1/polls");
    assert.deepEqual(calls[0]?.json, {
      question: "Which feature next?",
      options: ["Themes", "Exports"],
      show_results: true,
    });
    assert.equal(calls[1]?.url.pathname, "/v27.0/poll1");
    assert.deepEqual(calls[1]?.json, { action: "SHOW_VOTING" });
  });
});

describe("facebook video Insights", () => {
  it("reads Reels metrics such as blue_reels_play_count by default [feature:facebook.analytics.video_insights]", async () => {
    const { calls, native } = fake([
      {
        data: [
          {
            name: "blue_reels_play_count",
            period: "lifetime",
            values: [{ value: 1520 }],
          },
        ],
      },
      { data: [{ name: "total_video_views", period: "day", values: [{ value: 40 }] }] },
    ]);

    const reel = await native.getVideoInsights({ account: page, videoId: "r1", context });

    const video = await native.getVideoInsights({
      account: page,
      videoId: "v1",
      metrics: ["total_video_views"],
      period: "day",
      since: "2026-10-01T00:00:00Z",
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/r1/video_insights");
    assert.equal(calls[0]?.url.searchParams.get("metric"), facebookReelInsightMetrics.join(","));
    assert.equal(calls[0]?.url.searchParams.get("period"), "lifetime");
    assert.deepEqual(reel[0]?.values, [{ value: 1520 }]);
    assert.equal(calls[1]?.url.searchParams.get("metric"), "total_video_views");
    assert.equal(
      calls[1]?.url.searchParams.get("since"),
      String(Date.parse("2026-10-01T00:00:00Z") / 1000),
    );
    assert.equal(video[0]?.name, "total_video_views");
  });
});
