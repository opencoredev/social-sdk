import { it } from "node:test";
import assert from "node:assert/strict";
import {
  createSocial,
  connectedAccountRef,
  type AdapterOperationContext,
  type MediaAttachment,
} from "../src/index.js";
import { youtube } from "../src/platforms/youtube.js";
import { SocialError } from "../src/core/errors.js";
import type { JsonValue } from "../src/core/types.js";
import { parseJson } from "../src/transport/json.js";
import { array, object, string } from "../src/transport/validation.js";

const account = connectedAccountRef({
  backend: "default",
  platform: "youtube",
  accountId: "channel1",
});

const context = (): AdapterOperationContext => ({
  backendInstance: "default",
  correlationId: "native-features",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
});

const media: MediaAttachment = {
  kind: "video",
  mimeType: "video/mp4",
  source: { kind: "blob", blob: new Blob([new Uint8Array(10)]), fingerprint: "v1" },
};

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly body?: JsonValue;
}

/** A fake fetch that records each request and answers from `respond`. */
function recorder(respond: (call: Call) => Response = () => Response.json({})) {
  const calls: Call[] = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const raw = String(init?.body ?? "");

    const call: Call = raw.startsWith("{")
      ? { method, url, body: parseJson(raw) }
      : { method, url };

    calls.push(call);

    return respond(call);
  };

  return { calls, fetch };
}

const uploadResponder = (call: Call): Response =>
  call.method === "POST"
    ? new Response(null, {
        headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=s" },
      })
    : Response.json({ id: "video1", status: { uploadStatus: "uploaded" } });

it("uploads tags, defaultLanguage, localizations, license, embeddable, publicStatsViewable, containsSyntheticMedia, recordingDate and notifySubscribers [feature:youtube.publish.snippet.tags] [feature:youtube.publish.snippet.defaultLanguage] [feature:youtube.publish.localizations] [feature:youtube.publish.status.license] [feature:youtube.publish.status.embeddable] [feature:youtube.publish.status.publicStatsViewable] [feature:youtube.publish.status.containsSyntheticMedia]", async () => {
  const { calls, fetch } = recorder(uploadResponder);

  const social = createSocial({
    backend: youtube({ auth: { accessToken: "test", channelId: "channel1" }, fetch }),
  });

  const result = await social.posts.publish({
    targets: [
      {
        account,
        options: {
          title: "Release",
          visibility: "unlisted",
          madeForKids: false,
          tags: ["sdk", "social media"],
          defaultLanguage: "en",
          localizations: { de: { title: "Veröffentlichung", description: "Beschreibung" } },
          license: "creativeCommon",
          embeddable: false,
          publicStatsViewable: false,
          containsSyntheticMedia: true,
          recordingDate: "2026-10-01T09:30:00Z",
          notifySubscribers: false,
        },
      },
    ],
    content: { text: "Notes", media: [media] },
  });

  assert.equal(result.outcomes[0]?.state, "processing");

  const insert = calls[0];
  assert.equal(insert?.method, "POST");
  assert.equal(insert?.url.pathname, "/upload/youtube/v3/videos");
  assert.equal(
    insert?.url.searchParams.get("part"),
    "snippet,status,recordingDetails,localizations",
  );
  assert.equal(insert?.url.searchParams.get("notifySubscribers"), "false");
  assert.deepEqual(insert?.body, {
    snippet: {
      tags: ["sdk", "social media"],
      defaultLanguage: "en",
      title: "Release",
      description: "Notes",
    },
    status: {
      license: "creativeCommon",
      embeddable: false,
      publicStatsViewable: false,
      containsSyntheticMedia: true,
      privacyStatus: "unlisted",
      selfDeclaredMadeForKids: false,
    },
    recordingDetails: { recordingDate: "2026-10-01T09:30:00.000Z" },
    localizations: { de: { title: "Veröffentlichung", description: "Beschreibung" } },
  });
});

it("omits notifySubscribers and optional parts when they are not set", async () => {
  const { calls, fetch } = recorder(uploadResponder);

  const social = createSocial({
    backend: youtube({ auth: { accessToken: "test", channelId: "channel1" }, fetch }),
  });

  await social.posts.publish({
    targets: [{ account, options: { title: "Plain", visibility: "private", madeForKids: true } }],
    content: { media: [media] },
  });

  assert.equal(calls[0]?.url.searchParams.get("part"), "snippet,status");
  assert.equal(calls[0]?.url.searchParams.has("notifySubscribers"), false);
});

it("rejects invalid upload options before any request", async () => {
  const cases = [
    [{ tags: ["a".repeat(501)] }, "youtube.tags"],
    [{ tags: ["has,comma"] }, "youtube.tags"],
    // 98 three-character tags quoted for their space count 98 * 5 + 97 commas = 587 characters.
    [{ tags: Array.from({ length: 98 }, () => "a b") }, "youtube.tags"],
    [{ license: "public" }, "youtube.license"],
    [{ embeddable: "yes" }, "youtube.embeddable"],
    [{ recordingDate: "yesterday" }, "youtube.recordingDate"],
    [{ localizations: { de: { title: "Titel" } } }, "youtube.localizations"],
    [{ defaultLanguage: "en", localizations: { de: { title: "" } } }, "youtube.localizations"],
    [{ defaultLanguage: "english" }, "youtube.defaultLanguage"],
    [{ notifySubscribers: "no" }, "youtube.notifySubscribers"],
  ] as const;

  for (const [extra, code] of cases) {
    const { calls, fetch } = recorder();

    const social = createSocial({
      backend: youtube({ auth: { accessToken: "test", channelId: "channel1" }, fetch }),
    });

    const target = {
      account,
      options: { title: "T", visibility: "private", madeForKids: false, ...extra },
    };

    await assert.rejects(
      // @ts-expect-error -- each case deliberately breaks the typed option contract.
      social.posts.publish({ targets: [target], content: { media: [media] } }),
      (error: SocialError) =>
        error instanceof SocialError &&
        error.code === "invalid_input" &&
        (error.issues ?? []).some((issue) => issue.code === code),
      JSON.stringify(extra),
    );
    assert.equal(calls.length, 0, JSON.stringify(extra));
  }
});

it("updateVideo merges recordingDetails and localizations parts [feature:youtube.edit.videos.update]", async () => {
  const { calls, fetch } = recorder((call) =>
    call.method === "GET"
      ? Response.json({
          items: [
            {
              id: "video1",
              snippet: {
                channelId: "channel1",
                title: "Old",
                categoryId: "22",
                defaultLanguage: "en",
              },
              status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
              recordingDetails: { recordingDate: "2026-01-01T00:00:00.000Z" },
              localizations: { fr: { title: "Ancien" }, es: { title: "Viejo" } },
            },
          ],
        })
      : Response.json({ id: "video1" }),
  );

  const adapter = youtube({ auth: { accessToken: "test", channelId: "channel1" }, fetch });

  await adapter.native!.updateVideo({
    videoId: "video1",
    body: {
      recordingDetails: { recordingDate: "2026-10-02T08:00:00.000Z" },
      localizations: { de: { title: "Neu" }, es: null },
    },
    context: context(),
  });

  assert.equal(
    calls[0]?.url.searchParams.get("part"),
    "snippet,status,statistics,processingDetails,recordingDetails,localizations",
  );
  assert.equal(calls[1]?.method, "PUT");
  assert.equal(
    calls[1]?.url.searchParams.get("part"),
    "snippet,status,recordingDetails,localizations",
  );
  assert.deepEqual(calls[1]?.body, {
    id: "video1",
    snippet: { title: "Old", categoryId: "22", defaultLanguage: "en" },
    status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
    recordingDetails: { recordingDate: "2026-10-02T08:00:00.000Z" },
    localizations: { fr: { title: "Ancien" }, de: { title: "Neu" } },
  });
});

it("updateVideo refuses localizations without a default language", async () => {
  const { calls, fetch } = recorder(() =>
    Response.json({
      items: [
        {
          id: "video1",
          snippet: { channelId: "channel1", title: "Old", categoryId: "22" },
          status: { privacyStatus: "private" },
        },
      ],
    }),
  );

  const adapter = youtube({ auth: { accessToken: "test", channelId: "channel1" }, fetch });

  await assert.rejects(
    adapter.native!.updateVideo({
      videoId: "video1",
      body: { localizations: { de: { title: "Neu" } } },
      context: context(),
    }),
    { code: "invalid_input" },
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET"],
  );
});

const nativeFor = (respond?: (call: Call) => Response) => {
  const { calls, fetch } = recorder(respond);

  const adapter = youtube({ auth: { accessToken: "test", channelId: "channel1" }, fetch });

  return { calls, native: adapter.native! };
};

const query = (call: Call | undefined): Record<string, string> =>
  Object.fromEntries(call?.url.searchParams ?? []);

it("videos reads any video by ID with liveStreamingDetails and topicDetails parts", async () => {
  const { calls, native } = nativeFor(() =>
    Response.json({
      items: [
        {
          id: "other1",
          snippet: { channelId: "someone-else" },
          liveStreamingDetails: { activeLiveChatId: "chat1" },
          topicDetails: { topicCategories: ["https://en.wikipedia.org/wiki/Music"] },
        },
      ],
    }),
  );

  const result = await native.videos({
    filter: { kind: "id", ids: ["other1", "other2"] },
    parts: ["snippet", "liveStreamingDetails", "topicDetails"],
    context: context(),
  });

  assert.equal(calls[0]?.url.pathname, "/youtube/v3/videos");
  assert.deepEqual(query(calls[0]), {
    part: "snippet,liveStreamingDetails,topicDetails",
    id: "other1,other2",
  });
  assert.deepEqual(result["items"], [
    {
      id: "other1",
      snippet: { channelId: "someone-else" },
      liveStreamingDetails: { activeLiveChatId: "chat1" },
      topicDetails: { topicCategories: ["https://en.wikipedia.org/wiki/Music"] },
    },
  ]);
});

it("videos lists the mostPopular chart and the caller's myRating list", async () => {
  const { calls, native } = nativeFor(() => Response.json({ items: [] }));

  await native.videos({
    filter: { kind: "mostPopular", regionCode: "DE", videoCategoryId: "10" },
    maxResults: 10,
    context: context(),
  });
  await native.videos({
    filter: { kind: "myRating", rating: "dislike" },
    pageToken: "next",
    context: context(),
  });

  assert.deepEqual(query(calls[0]), {
    part: "snippet,contentDetails,statistics",
    chart: "mostPopular",
    regionCode: "DE",
    videoCategoryId: "10",
    maxResults: "10",
  });
  assert.deepEqual(query(calls[1]), {
    part: "snippet,contentDetails,statistics",
    myRating: "dislike",
    pageToken: "next",
  });

  for (const input of [
    { filter: { kind: "id" as const, ids: [] } },
    { filter: { kind: "id" as const, ids: ["a"] }, maxResults: 5 },
    { filter: { kind: "mostPopular" as const, regionCode: "germany" } },
    { filter: { kind: "mostPopular" as const }, maxResults: 51 },
  ])
    await assert.rejects(native.videos({ ...input, context: context() }), {
      code: "invalid_input",
    });
  assert.equal(calls.length, 2);
});

it("batchGetStats reads statistics from the videos:batchGetStats route", async () => {
  const { calls, native } = nativeFor(() =>
    Response.json({
      kind: "youtube#batchGetStatsResponse",
      items: [{ id: "v1", statistics: { viewCount: "5" } }],
      summary: { requestedVideoCount: 2, succeededVideoCount: 1, failedVideoIds: ["v2"] },
    }),
  );

  const result = await native.batchGetStats({ videoIds: ["v1", "v2"], context: context() });

  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.url.pathname, "/youtube/v3/videos:batchGetStats");
  assert.deepEqual(query(calls[0]), { id: "v1,v2", part: "statistics" });
  assert.deepEqual(result["summary"], {
    requestedVideoCount: 2,
    succeededVideoCount: 1,
    failedVideoIds: ["v2"],
  });
});

it("channels looks up another channel by forHandle, forUsername or ID", async () => {
  const { calls, native } = nativeFor(() => Response.json({ items: [] }));

  await native.channels({
    filter: { kind: "handle", handle: "@GoogleDevelopers" },
    context: context(),
  });
  await native.channels({
    filter: { kind: "username", username: "GoogleDevelopers" },
    parts: ["snippet"],
    context: context(),
  });
  await native.channels({ filter: { kind: "id", ids: ["UC1", "UC2"] }, context: context() });

  assert.deepEqual(
    calls.map((call) => query(call)),
    [
      { part: "snippet,statistics", forHandle: "@GoogleDevelopers" },
      { part: "snippet", forUsername: "GoogleDevelopers" },
      { part: "snippet,statistics", id: "UC1,UC2" },
    ],
  );
  await assert.rejects(
    native.channels({ filter: { kind: "handle", handle: " " }, context: context() }),
    { code: "invalid_input" },
  );
});

it("search sends eventType, regionCode, relevanceLanguage, safeSearch, videoDuration and location filters", async () => {
  const { calls, native } = nativeFor(() => Response.json({ items: [] }));

  await native.search({
    q: "launch",
    type: "video",
    eventType: "live",
    regionCode: "US",
    relevanceLanguage: "en",
    safeSearch: "strict",
    videoDuration: "short",
    videoLicense: "creativeCommon",
    location: { latitude: 37.42307, longitude: -122.08427, radius: "5km" },
    context: context(),
  });

  assert.deepEqual(query(calls[0]), {
    part: "snippet",
    q: "launch",
    type: "video",
    regionCode: "US",
    relevanceLanguage: "en",
    safeSearch: "strict",
    eventType: "live",
    videoDuration: "short",
    videoLicense: "creativeCommon",
    location: "37.42307,-122.08427",
    locationRadius: "5km",
  });

  await assert.rejects(
    native.search({ q: "x", type: "channel", eventType: "live", context: context() }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    native.search({
      q: "x",
      type: "video",
      location: { latitude: 0, longitude: 0, radius: "2000km" },
      context: context(),
    }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 1);
});

it("lists videoCategories, i18nLanguages, i18nRegions and abuse reasons, and reports abuse", async () => {
  const { calls, native } = nativeFor((call) =>
    call.method === "POST" ? new Response(null, { status: 204 }) : Response.json({ items: [] }),
  );

  await native.videoCategories({
    filter: { kind: "region", regionCode: "GB" },
    hl: "en_GB",
    context: context(),
  });
  await native.i18n({ resource: "languages", context: context() });
  await native.i18n({ resource: "regions", hl: "de", context: context() });
  await native.videoAbuseReportReasons({ context: context() });
  await native.reportAbuse({
    videoId: "v9",
    reasonId: "S",
    secondaryReasonId: "27",
    comments: "Impersonation",
    context: context(),
  });

  assert.deepEqual(
    calls.map((call) => [call.method, call.url.pathname, query(call)]),
    [
      ["GET", "/youtube/v3/videoCategories", { part: "snippet", regionCode: "GB", hl: "en_GB" }],
      ["GET", "/youtube/v3/i18nLanguages", { part: "snippet" }],
      ["GET", "/youtube/v3/i18nRegions", { part: "snippet", hl: "de" }],
      ["GET", "/youtube/v3/videoAbuseReportReasons", { part: "id,snippet" }],
      ["POST", "/youtube/v3/videos/reportAbuse", {}],
    ],
  );
  assert.deepEqual(calls[4]?.body, {
    videoId: "v9",
    reasonId: "S",
    secondaryReasonId: "27",
    comments: "Impersonation",
  });
});

it("subscriptions lists mySubscribers and myRecentSubscribers with forChannelId and order", async () => {
  const { calls, native } = nativeFor(() => Response.json({ items: [] }));

  await native.subscriptions({
    action: "list",
    subscribers: "all",
    maxResults: 50,
    context: context(),
  });
  await native.subscriptions({ action: "list", subscribers: "recent", context: context() });
  await native.subscriptions({
    action: "list",
    forChannelIds: ["UC1", "UC2"],
    order: "alphabetical",
    context: context(),
  });

  assert.deepEqual(
    calls.map((call) => query(call)),
    [
      { part: "snippet,contentDetails,subscriberSnippet", mySubscribers: "true", maxResults: "50" },
      { part: "snippet,contentDetails,subscriberSnippet", myRecentSubscribers: "true" },
      {
        part: "snippet,contentDetails",
        mine: "true",
        forChannelId: "UC1,UC2",
        order: "alphabetical",
      },
    ],
  );
  await assert.rejects(
    native.subscriptions({
      action: "list",
      subscribers: "all",
      channelId: "UC1",
      context: context(),
    }),
    { code: "invalid_input" },
  );
});

it("commentThreads lists with searchTerms, order and likelySpam, and heldComments reads likelySpam", async () => {
  const { calls, native } = nativeFor(() => Response.json({ items: [] }));

  await native.commentThreads({
    action: "list",
    filter: { kind: "video", videoId: "v1" },
    searchTerms: "release date",
    order: "relevance",
    textFormat: "plainText",
    includeReplies: true,
    maxResults: 100,
    context: context(),
  });
  await native.commentThreads({
    action: "list",
    filter: { kind: "channel" },
    moderationStatus: "likelySpam",
    context: context(),
  });
  await native.heldComments({ moderationStatus: "likelySpam", context: context() });

  assert.deepEqual(
    calls.map((call) => query(call)),
    [
      {
        part: "snippet,replies",
        videoId: "v1",
        searchTerms: "release date",
        order: "relevance",
        textFormat: "plainText",
        maxResults: "100",
      },
      { part: "snippet", allThreadsRelatedToChannelId: "channel1", moderationStatus: "likelySpam" },
      { part: "snippet", moderationStatus: "likelySpam", allThreadsRelatedToChannelId: "channel1" },
    ],
  );
});

it("commentThreads inserts a top-level comment [feature:youtube.comments.topLevel.create]", async () => {
  const { calls, native } = nativeFor(() =>
    Response.json({ id: "thread1", snippet: { videoId: "v1" } }),
  );

  const result = await native.commentThreads({
    action: "insert",
    videoId: "v1",
    text: "Thanks for watching",
    context: context(),
  });

  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url.pathname, "/youtube/v3/commentThreads");
  assert.deepEqual(query(calls[0]), { part: "snippet" });
  assert.deepEqual(calls[0]?.body, {
    snippet: {
      channelId: "channel1",
      videoId: "v1",
      topLevelComment: { snippet: { textOriginal: "Thanks for watching" } },
    },
  });
  assert.equal(result["id"], "thread1");
  await assert.rejects(
    native.commentThreads({ action: "insert", videoId: "v1", text: " ", context: context() }),
    { code: "invalid_input" },
  );
});

it("commentReplies lists replies by parentId [feature:youtube.comments.replies.list]", async () => {
  const { calls, native } = nativeFor(() => Response.json({ items: [{ id: "reply1" }] }));

  await native.commentReplies({
    parentId: "top1",
    maxResults: 50,
    pageToken: "p2",
    context: context(),
  });

  assert.equal(calls[0]?.url.pathname, "/youtube/v3/comments");
  assert.deepEqual(query(calls[0]), {
    part: "snippet",
    parentId: "top1",
    pageToken: "p2",
    maxResults: "50",
  });
});

it("comments.list surfaces an attached comment imageUrl", async () => {
  const social = createSocial({
    backend: youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      fetch: async () =>
        Response.json({
          items: [
            {
              snippet: {
                videoId: "v1",
                topLevelComment: {
                  id: "c1",
                  snippet: {
                    textDisplay: "look",
                    imageUrl: "https://yt3.ggpht.example/signed-image",
                  },
                },
              },
            },
          ],
        }),
    }),
  });

  const page = await social.comments.list({ ...account, kind: "platform-post", postId: "v1" });

  assert.equal(page.items[0]?.["imageUrl"], "https://yt3.ggpht.example/signed-image");
});

it("rates a video with videos/rate, reads getRating, and calls setModerationStatus with banAuthor", async () => {
  const { calls, native } = nativeFor((call) =>
    call.method === "POST"
      ? new Response(null, { status: 204 })
      : Response.json({ items: [{ videoId: "v1", rating: "like" }] }),
  );

  await native.rateVideo({ videoId: "v1", rating: "like", context: context() });
  const rating = await native.getRating({ videoIds: ["v1", "v2"], context: context() });
  await native.commentsModeration({
    action: "setModerationStatus",
    commentId: "c1",
    moderationStatus: "rejected",
    banAuthor: true,
    context: context(),
  });

  assert.deepEqual(
    calls.map((call) => [call.method, call.url.pathname, query(call)]),
    [
      ["POST", "/youtube/v3/videos/rate", { id: "v1", rating: "like" }],
      ["GET", "/youtube/v3/videos/getRating", { id: "v1,v2" }],
      [
        "POST",
        "/youtube/v3/comments/setModerationStatus",
        { id: "c1", moderationStatus: "rejected", banAuthor: "true" },
      ],
    ],
  );
  assert.deepEqual(rating["items"], [{ videoId: "v1", rating: "like" }]);
});

it("liveBroadcasts updates and deletes a broadcast [feature:youtube.live.broadcasts.update_delete]", async () => {
  const { calls, native } = nativeFor((call) =>
    call.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ id: "b1" }),
  );

  await native.liveBroadcasts({
    action: "update",
    id: "b1",
    body: {
      snippet: { title: "Launch stream", scheduledStartTime: "2026-12-01T18:00:00Z" },
      contentDetails: {
        monitorStream: { enableMonitorStream: true, broadcastStreamDelayMs: 0 },
        enableAutoStart: true,
      },
    },
    context: context(),
  });
  await native.liveBroadcasts({ action: "delete", id: "b1", context: context() });

  assert.deepEqual(
    calls.map((call) => [call.method, call.url.pathname, query(call)]),
    [
      ["PUT", "/youtube/v3/liveBroadcasts", { part: "snippet,contentDetails" }],
      ["DELETE", "/youtube/v3/liveBroadcasts", { id: "b1" }],
    ],
  );
  assert.deepEqual(calls[0]?.body, {
    id: "b1",
    snippet: { title: "Launch stream", scheduledStartTime: "2026-12-01T18:00:00Z" },
    contentDetails: {
      monitorStream: { enableMonitorStream: true, broadcastStreamDelayMs: 0 },
      enableAutoStart: true,
    },
  });
  await assert.rejects(native.liveBroadcasts({ action: "delete", context: context() }), {
    code: "invalid_input",
  });
  await assert.rejects(
    native.liveBroadcasts({
      action: "update",
      id: "b1",
      body: { id: "other", snippet: {} },
      context: context(),
    }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 2);
});

it("liveBroadcasts binds to a stream with /liveBroadcasts/bind and inserts an ad cuepoint", async () => {
  const { calls, native } = nativeFor(() => Response.json({ id: "b1" }));

  await native.liveBroadcasts({ action: "bind", id: "b1", streamId: "s1", context: context() });
  await native.liveBroadcasts({ action: "bind", id: "b1", context: context() });
  await native.liveBroadcasts({
    action: "cuepoint",
    id: "b1",
    cuepoint: { durationSecs: 60, walltimeMs: 1_790_000_000_000 },
    context: context(),
  });

  assert.deepEqual(
    calls.map((call) => [call.method, call.url.pathname, query(call)]),
    [
      [
        "POST",
        "/youtube/v3/liveBroadcasts/bind",
        { id: "b1", part: "id,snippet,contentDetails,status", streamId: "s1" },
      ],
      [
        "POST",
        "/youtube/v3/liveBroadcasts/bind",
        { id: "b1", part: "id,snippet,contentDetails,status" },
      ],
      ["POST", "/youtube/v3/liveBroadcasts/cuepoint", { id: "b1" }],
    ],
  );
  assert.deepEqual(calls[2]?.body, {
    cueType: "cueTypeAd",
    durationSecs: 60,
    walltimeMs: 1_790_000_000_000,
  });
  await assert.rejects(
    native.liveBroadcasts({
      action: "cuepoint",
      id: "b1",
      cuepoint: { insertionOffsetTimeMs: 1000, walltimeMs: 1 },
      context: context(),
    }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    native.liveBroadcasts({
      action: "cuepoint",
      id: "b1",
      cuepoint: { durationSecs: 0 },
      context: context(),
    }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 3);
});

it("liveStreams lists, inserts, updates and deletes on /youtube/v3/liveStreams", async () => {
  const { calls, native } = nativeFor((call) =>
    call.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({ id: "s1", cdn: { ingestionInfo: { ingestionAddress: "rtmp://a" } } }),
  );

  const stream = {
    snippet: { title: "Main encoder" },
    cdn: { ingestionType: "rtmp", resolution: "1080p", frameRate: "30fps" },
    contentDetails: { isReusable: true },
  };

  await native.liveStreams({ action: "list", maxResults: 50, context: context() });
  await native.liveStreams({ action: "list", ids: ["s1"], context: context() });
  const created = await native.liveStreams({ action: "insert", body: stream, context: context() });
  await native.liveStreams({
    action: "update",
    streamId: "s1",
    body: { snippet: { title: "Backup encoder" }, cdn: stream.cdn },
    context: context(),
  });
  await native.liveStreams({ action: "delete", streamId: "s1", context: context() });

  assert.deepEqual(
    calls.map((call) => [call.method, call.url.pathname, query(call)]),
    [
      [
        "GET",
        "/youtube/v3/liveStreams",
        { part: "id,snippet,cdn,status", mine: "true", maxResults: "50" },
      ],
      ["GET", "/youtube/v3/liveStreams", { part: "id,snippet,cdn,status", id: "s1" }],
      ["POST", "/youtube/v3/liveStreams", { part: "snippet,cdn,contentDetails" }],
      ["PUT", "/youtube/v3/liveStreams", { part: "snippet,cdn" }],
      ["DELETE", "/youtube/v3/liveStreams", { id: "s1" }],
    ],
  );
  assert.deepEqual(calls[2]?.body, stream);
  assert.deepEqual(calls[3]?.body, {
    id: "s1",
    snippet: { title: "Backup encoder" },
    cdn: stream.cdn,
  });
  assert.deepEqual(created["cdn"], { ingestionInfo: { ingestionAddress: "rtmp://a" } });
  await assert.rejects(
    native.liveStreams({
      action: "insert",
      body: { snippet: { title: "No cdn" } },
      context: context(),
    }),
    { code: "invalid_input" },
  );
});

it("superChatEvents lists recent Super Chat purchases", async () => {
  const { calls, native } = nativeFor(() =>
    Response.json({
      items: [{ id: "sc1", snippet: { amountMicros: "5000000", currency: "USD" } }],
    }),
  );

  const result = await native.superChatEvents({ hl: "de", maxResults: 50, context: context() });

  assert.equal(calls[0]?.url.pathname, "/youtube/v3/superChatEvents");
  assert.deepEqual(query(calls[0]), { part: "snippet", hl: "de", maxResults: "50" });
  assert.deepEqual(result["items"], [
    { id: "sc1", snippet: { amountMicros: "5000000", currency: "USD" } },
  ]);
  await assert.rejects(native.superChatEvents({ maxResults: 0, context: context() }), {
    code: "invalid_input",
  });
});

/** Read a recorded multipart/related body back into its JSON part and media part. */
async function multipartParts(init: RequestInit | undefined) {
  const text = await new Response(init?.body ?? null).text();

  const contentType = new Headers(init?.headers).get("content-type") ?? "";

  const boundary = /boundary=(.+)$/u.exec(contentType)?.[1] ?? "";

  const sections = text.split(`--${boundary}`).slice(1, -1);

  const [metadata, media] = sections.map((section) => section.split("\r\n\r\n")[1]?.trimEnd());

  return { contentType, metadata: parseJson(metadata ?? ""), media };
}

it("uploads a channel banner to channelBanners/insert and sets bannerExternalUrl", async () => {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];

  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, init });

      if (url.pathname === "/upload/youtube/v3/channelBanners/insert")
        return Response.json({ url: "https://yt3.googleusercontent.com/banner1" });

      if (init?.method === "PUT") return Response.json({ id: "channel1" });

      return Response.json({
        items: [
          {
            id: "channel1",
            brandingSettings: {
              channel: { description: "Kept" },
              image: { bannerExternalUrl: "https://yt3.googleusercontent.com/old" },
            },
          },
        ],
      });
    },
  });

  const banner = await adapter.native!.uploadChannelBanner({
    image: {
      kind: "image",
      mimeType: "image/png",
      source: { kind: "blob", blob: new Blob([new Uint8Array(8)]), fingerprint: "banner" },
    },
    context: context(),
  });

  await adapter.native!.updateProfile({
    part: "brandingSettings",
    value: { image: { bannerExternalUrl: String(banner["url"]) } },
    context: context(),
  });

  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(requests[0]?.url.searchParams.get("uploadType"), "media");
  assert.equal(new Headers(requests[0]?.init?.headers).get("content-type"), "image/png");
  assert.equal(requests[2]?.init?.method, "PUT");
  assert.deepEqual(parseJson(String(requests[2]?.init?.body)), {
    id: "channel1",
    brandingSettings: {
      channel: { description: "Kept" },
      image: { bannerExternalUrl: "https://yt3.googleusercontent.com/banner1" },
    },
  });

  await assert.rejects(
    adapter.native!.uploadChannelBanner({
      image: {
        kind: "image",
        mimeType: "image/gif",
        source: { kind: "blob", blob: new Blob(["gif"]), fingerprint: "g" },
      },
      context: context(),
    }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    adapter.native!.updateProfile({
      part: "brandingSettings",
      value: { image: { bannerExternalUrl: "http://insecure.example/banner" } },
      context: context(),
    }),
    { code: "invalid_input" },
  );
  assert.equal(requests.length, 3);
});

it("sets a watermark with /watermarks/set as multipart and unsets it", async () => {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];

  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (input, init) => {
      requests.push({ url: new URL(String(input)), init });

      return new Response(null, { status: 204 });
    },
  });

  await adapter.native!.watermarks({
    action: "set",
    image: {
      kind: "image",
      mimeType: "image/png",
      source: { kind: "blob", blob: new Blob(["PNGDATA"]), fingerprint: "wm" },
    },
    timing: { type: "offsetFromEnd", offsetMs: 15_000, durationMs: 10_000 },
    context: context(),
  });
  await adapter.native!.watermarks({ action: "unset", context: context() });

  assert.equal(requests[0]?.url.pathname, "/upload/youtube/v3/watermarks/set");
  assert.deepEqual(Object.fromEntries(requests[0]?.url.searchParams ?? []), {
    channelId: "channel1",
    uploadType: "multipart",
  });

  const parts = await multipartParts(requests[0]?.init);
  assert.match(parts.contentType, /^multipart\/related; boundary=/u);
  assert.deepEqual(parts.metadata, {
    timing: { type: "offsetFromEnd", offsetMs: 15_000, durationMs: 10_000 },
  });
  assert.equal(parts.media, "PNGDATA");
  assert.equal(requests[1]?.init?.method, "POST");
  assert.equal(requests[1]?.url.pathname, "/youtube/v3/watermarks/unset");
  assert.equal(requests[1]?.url.searchParams.get("channelId"), "channel1");

  await assert.rejects(
    adapter.native!.watermarks({
      action: "set",
      image: {
        kind: "image",
        mimeType: "image/png",
        source: { kind: "blob", blob: new Blob(["x"]), fingerprint: "wm" },
      },
      timing: { type: "offsetFromEnd", offsetMs: 5000, durationMs: 6000 },
      context: context(),
    }),
    { code: "invalid_input" },
  );
  assert.equal(requests.length, 2);
});

it("manages playlistImages: list by parent, multipart insert and update, delete", async () => {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];

  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (input, init) => {
      requests.push({ url: new URL(String(input)), init });

      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ id: "img1", snippet: { playlistId: "PL1", type: "hero" } });
    },
  });

  const image: MediaAttachment = {
    kind: "image",
    mimeType: "image/jpeg",
    source: { kind: "blob", blob: new Blob(["JPEG"]), fingerprint: "pi" },
  };

  await adapter.native!.playlistImages({ action: "list", playlistId: "PL1", context: context() });

  const inserted = await adapter.native!.playlistImages({
    action: "insert",
    playlistId: "PL1",
    image,
    context: context(),
  });

  await adapter.native!.playlistImages({
    action: "update",
    playlistImageId: "img1",
    playlistId: "PL1",
    image,
    context: context(),
  });
  await adapter.native!.playlistImages({
    action: "delete",
    playlistImageId: "img1",
    context: context(),
  });

  assert.deepEqual(
    requests.map((request) => [
      request.init?.method ?? "GET",
      request.url.pathname,
      Object.fromEntries(request.url.searchParams),
    ]),
    [
      ["GET", "/youtube/v3/playlistImages", { part: "id,snippet", parent: "PL1" }],
      [
        "POST",
        "/upload/youtube/v3/playlistImages",
        { part: "id,snippet", uploadType: "multipart" },
      ],
      ["PUT", "/upload/youtube/v3/playlistImages", { part: "id,snippet", uploadType: "multipart" }],
      ["DELETE", "/youtube/v3/playlistImages", { id: "img1" }],
    ],
  );
  assert.deepEqual((await multipartParts(requests[1]?.init)).metadata, {
    snippet: { playlistId: "PL1", type: "hero" },
  });

  const update = await multipartParts(requests[2]?.init);
  assert.deepEqual(update.metadata, { id: "img1", snippet: { playlistId: "PL1", type: "hero" } });
  assert.equal(update.media, "JPEG");
  assert.equal(inserted["id"], "img1");
});

it("lists channel members and membership levels from /youtube/v3/members and /membershipsLevels", async () => {
  const { calls, native } = nativeFor(() => Response.json({ items: [] }));

  await native.members({
    mode: "updates",
    filterByMemberChannelIds: ["UC1", "UC2"],
    hasAccessToLevel: "level1",
    maxResults: 1000,
    context: context(),
  });
  await native.membershipsLevels({ context: context() });

  assert.deepEqual(
    calls.map((call) => [call.url.pathname, query(call)]),
    [
      [
        "/youtube/v3/members",
        {
          part: "snippet",
          mode: "updates",
          filterByMemberChannelId: "UC1,UC2",
          hasAccessToLevel: "level1",
          maxResults: "1000",
        },
      ],
      ["/youtube/v3/membershipsLevels", { part: "id,snippet" }],
    ],
  );
  await assert.rejects(native.members({ maxResults: 1001, context: context() }), {
    code: "invalid_input",
  });
});

it("manages Analytics groups and groupItems on youtubeanalytics /v2/groups and /v2/groupItems", async () => {
  const { calls, native } = nativeFor((call) =>
    call.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ id: "g1" }),
  );

  await native.analyticsGroups({ action: "list", context: context() });
  await native.analyticsGroups({
    action: "insert",
    title: "Launch videos",
    itemType: "youtube#video",
    context: context(),
  });
  await native.analyticsGroups({
    action: "update",
    groupId: "g1",
    title: "Launch week",
    context: context(),
  });
  await native.analyticsGroupItems({
    action: "insert",
    groupId: "g1",
    resource: { kind: "youtube#video", id: "v1" },
    context: context(),
  });
  await native.analyticsGroupItems({ action: "list", groupId: "g1", context: context() });
  await native.analyticsGroupItems({ action: "delete", groupItemId: "gi1", context: context() });
  await native.analyticsGroups({ action: "delete", groupId: "g1", context: context() });

  assert.deepEqual(
    calls.map((call) => [call.method, call.url.origin + call.url.pathname, query(call)]),
    [
      ["GET", "https://youtubeanalytics.googleapis.com/v2/groups", { mine: "true" }],
      ["POST", "https://youtubeanalytics.googleapis.com/v2/groups", {}],
      ["PUT", "https://youtubeanalytics.googleapis.com/v2/groups", {}],
      ["POST", "https://youtubeanalytics.googleapis.com/v2/groupItems", {}],
      ["GET", "https://youtubeanalytics.googleapis.com/v2/groupItems", { groupId: "g1" }],
      ["DELETE", "https://youtubeanalytics.googleapis.com/v2/groupItems", { id: "gi1" }],
      ["DELETE", "https://youtubeanalytics.googleapis.com/v2/groups", { id: "g1" }],
    ],
  );
  assert.deepEqual(calls[1]?.body, {
    snippet: { title: "Launch videos" },
    contentDetails: { itemType: "youtube#video" },
  });
  assert.deepEqual(calls[2]?.body, { id: "g1", snippet: { title: "Launch week" } });
  assert.deepEqual(calls[3]?.body, {
    groupId: "g1",
    resource: { kind: "youtube#video", id: "v1" },
  });
});

it("drives the youtubereporting API: report types, jobs, reports and a bounded CSV download", async () => {
  const { calls, native } = nativeFor((call) => {
    if (call.url.pathname.startsWith("/v1/media/"))
      return new Response("date,views\n20261101,5\n", { headers: { "content-type": "text/csv" } });

    if (call.method === "DELETE") return new Response(null, { status: 204 });

    if (call.url.pathname.endsWith("/reports"))
      return Response.json({
        reports: [
          {
            id: "r1",
            downloadUrl: "https://youtubereporting.googleapis.com/v1/media/CHANNEL/r1?alt=media",
          },
        ],
      });

    return Response.json({ id: "job1", reportTypeId: "channel_basic_a2" });
  });

  await native.reportTypes({ includeSystemManaged: false, pageSize: 10, context: context() });
  await native.reportingJobs({
    action: "create",
    reportTypeId: "channel_basic_a2",
    name: "Daily basics",
    context: context(),
  });
  await native.reportingJobs({ action: "list", context: context() });
  await native.reportingJobs({ action: "get", jobId: "job1", context: context() });

  const page = await native.reports({
    action: "list",
    jobId: "job1",
    createdAfter: "2026-11-01T00:00:00Z",
    context: context(),
  });

  await native.reports({ action: "get", jobId: "job1", reportId: "r1", context: context() });

  const report = array(page["reports"]).map(object)[0];

  const csv = await native.downloadReport({
    downloadUrl: string(report?.["downloadUrl"]),
    context: context(),
  });

  await native.reportingJobs({ action: "delete", jobId: "job1", context: context() });

  assert.deepEqual(
    calls.map((call) => [call.method, call.url.origin + call.url.pathname, query(call)]),
    [
      [
        "GET",
        "https://youtubereporting.googleapis.com/v1/reportTypes",
        { includeSystemManaged: "false", pageSize: "10" },
      ],
      ["POST", "https://youtubereporting.googleapis.com/v1/jobs", {}],
      ["GET", "https://youtubereporting.googleapis.com/v1/jobs", {}],
      ["GET", "https://youtubereporting.googleapis.com/v1/jobs/job1", {}],
      [
        "GET",
        "https://youtubereporting.googleapis.com/v1/jobs/job1/reports",
        { createdAfter: "2026-11-01T00:00:00Z" },
      ],
      ["GET", "https://youtubereporting.googleapis.com/v1/jobs/job1/reports/r1", {}],
      ["GET", "https://youtubereporting.googleapis.com/v1/media/CHANNEL/r1", { alt: "media" }],
      ["DELETE", "https://youtubereporting.googleapis.com/v1/jobs/job1", {}],
    ],
  );
  assert.deepEqual(calls[1]?.body, { reportTypeId: "channel_basic_a2", name: "Daily basics" });
  assert.equal(await csv.text(), "date,views\n20261101,5\n");

  await assert.rejects(
    native.downloadReport({
      downloadUrl: "https://attacker.example/v1/media/x",
      context: context(),
    }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 8);
});
