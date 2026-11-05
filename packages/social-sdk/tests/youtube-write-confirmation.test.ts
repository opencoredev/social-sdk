/**
 * Every YouTube write is confirmed only by its documented success answer. Each row sends one
 * write and gets one answer: the documented one resolves, and every malformed one (a JSON
 * `null`, an array, an empty object, a wrong-type or other ID, a malformed nested part, or a
 * success status other than the documented 204) is `ambiguous_outcome` with `reconcile-first`.
 * The sweep behind this table is in the SOC-37 write-confirmation notes.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { SocialError, type AdapterOperationContext } from "../src/index.js";
import type { JsonValue } from "../src/core/types.js";
import { youtube, type YouTubeNative } from "../src/platforms/youtube.js";
import { sendYouTubeUpload } from "../src/platforms/youtube-upload.js";

const context = (): AdapterOperationContext => ({
  backendInstance: "default",
  correlationId: "write-confirmation",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
});

function uncertain(error: SocialError): boolean {
  return (
    error instanceof SocialError &&
    error.code === "ambiguous_outcome" &&
    error.retryDisposition.kind === "reconcile-first"
  );
}

interface Answer {
  readonly name: string;
  readonly respond: () => Response;
}

const json = (name: string, body: JsonValue, status = 200): Answer => ({
  name,
  respond: () => Response.json(body, { status }),
});

const noContent: Answer = {
  name: "204 No Content",
  respond: () => new Response(null, { status: 204 }),
};

/** Success answers that are not a resource with a usable ID. */
const notResources: readonly Answer[] = [
  json("JSON null", null),
  json("array", []),
  json("empty object", {}),
  json("numeric id", { id: 7 }),
  json("blank id", { id: "  " }),
  noContent,
];

/** Success answers other than the documented 204 No Content. */
const notNoContent: readonly Answer[] = [
  json("JSON null", null),
  json("array", []),
  json("empty object", {}),
  json("a resource", { id: "other1" }),
  { name: "201 without a body", respond: () => new Response(null, { status: 201 }) },
];

const image = {
  kind: "image",
  mimeType: "image/png",
  source: { kind: "blob", blob: new Blob(["png"], { type: "image/png" }), fingerprint: "image" },
} as const;

const caption = {
  kind: "document",
  filename: "captions.vtt",
  mimeType: "text/vtt",
  source: { kind: "blob", blob: new Blob(["WEBVTT"]), fingerprint: "caption" },
} as const;

/** Read answers for the preflight GETs some writes make before their one write. */
function read(url: URL): Response {
  switch (url.pathname) {
    case "/youtube/v3/videos":
      return Response.json({
        items: [
          {
            id: "video1",
            snippet: { channelId: "channel1", title: "Title", categoryId: "22" },
            status: {
              privacyStatus: "private",
              publishAt: "2099-01-01T00:00:00Z",
              uploadStatus: "uploaded",
              selfDeclaredMadeForKids: false,
            },
          },
        ],
      });
    case "/youtube/v3/channels":
      return Response.json({
        items: [
          { id: "channel1", snippet: { title: "Channel" }, brandingSettings: { channel: {} } },
        ],
      });
    case "/youtube/v3/liveChat/moderators":
      return Response.json({ items: [{ id: "moderator1", snippet: { liveChatId: "chat1" } }] });
    case "/youtube/v3/channelSections":
      return Response.json({ items: [{ id: "section1", snippet: { channelId: "channel1" } }] });
    case "/youtube/v3/commentThreads":
      return Response.json({
        items: [{ snippet: { videoId: "video1", topLevelComment: { id: "comment1" } } }],
      });
    default:
      return Response.json({ items: [] });
  }
}

function setup(answer: Answer) {
  let writes = 0;

  const adapter = youtube({
    auth: { accessToken: "fixture-only", channelId: "channel1" },
    fetch: async (input, init) => {
      const method = init?.method ?? "GET";

      if (method === "GET") return read(new URL(String(input)));
      writes++;

      return answer.respond();
    },
  });

  return { adapter, writes: () => writes };
}

type Adapter = ReturnType<typeof youtube>;

interface Write {
  readonly name: string;
  readonly run: (native: YouTubeNative, adapter: Adapter) => Promise<object | void>;
  /** The documented success answer. */
  readonly valid: readonly Answer[];
  /** Answers that must stay uncertain. */
  readonly malformed: readonly Answer[];
}

/** A resource write: the documented answer is the resource with its ID. */
const resource = (
  name: string,
  run: Write["run"],
  valid: JsonValue = { id: "created1" },
  extra: readonly Answer[] = [],
): Write => ({
  name,
  run,
  valid: [json("documented resource", valid)],
  malformed: [...notResources, ...extra],
});

/** An update: the documented answer is the addressed resource, so another ID is uncertain. */
const update = (name: string, id: string, run: Write["run"]): Write =>
  resource(name, run, { id }, [json("another resource's id", { id: "other1" })]);

/** A write documented as HTTP 204 No Content. */
const empty = (name: string, run: Write["run"]): Write => ({
  name,
  run,
  valid: [noContent],
  malformed: notNoContent,
});

const nativeOf = (adapter: Adapter): YouTubeNative => {
  assert.ok(adapter.native);

  return adapter.native;
};

const writes: readonly Write[] = [
  // Normalized writes.
  empty("posts.removeFromPlatform", (_native, adapter) => {
    assert.ok(adapter.posts?.removeFromPlatform);

    return adapter.posts.removeFromPlatform(
      {
        kind: "platform-post",
        version: 1,
        backend: "default",
        platform: "youtube",
        accountId: "channel1",
        postId: "video1",
      },
      context(),
    );
  }),
  {
    name: "posts.cancelScheduled",
    run: (_native, adapter) => {
      assert.ok(adapter.posts?.cancelScheduled);

      return adapter.posts.cancelScheduled(
        {
          kind: "scheduled-job",
          version: 1,
          backend: "default",
          platform: "youtube",
          accountId: "channel1",
          jobId: "video1",
        },
        context(),
      );
    },
    valid: [json("cleared schedule", { id: "video1", status: { privacyStatus: "private" } })],
    malformed: [
      ...notResources,
      json("another video", { id: "other1", status: { privacyStatus: "private" } }),
      json("null status", { id: "video1", status: null }),
      json("array status", { id: "video1", status: [] }),
      json("public status", { id: "video1", status: { privacyStatus: "public" } }),
      json("kept publishAt", {
        id: "video1",
        status: { privacyStatus: "private", publishAt: "2099-01-01T00:00:00Z" },
      }),
    ],
  },
  resource("comments.reply", (_native, adapter) => {
    assert.ok(adapter.comments?.reply);

    return adapter.comments.reply(
      {
        kind: "comment",
        version: 1,
        backend: "default",
        platform: "youtube",
        accountId: "channel1",
        postId: "video1",
        commentId: "comment1",
      },
      { text: "Thanks" },
      context(),
    );
  }),
  // Native resource creates.
  resource("playlists.insert", (native) =>
    native.playlists({ action: "insert", body: { snippet: { title: "A" } }, context: context() }),
  ),
  resource("playlistItems.insert", (native) =>
    native.playlistItems({
      action: "insert",
      body: {
        snippet: { playlistId: "p1", resourceId: { kind: "youtube#video", videoId: "v1" } },
      },
      context: context(),
    }),
  ),
  resource("subscriptions.insert", (native) =>
    native.subscriptions({ action: "insert", channelId: "target", context: context() }),
  ),
  resource("captions.insert", (native) =>
    native.captions({
      action: "insert",
      videoId: "video1",
      caption,
      body: { snippet: { language: "en", name: "English" } },
      context: context(),
    }),
  ),
  resource("commentThreads.insert", (native) =>
    native.commentThreads({ action: "insert", videoId: "video1", text: "Hi", context: context() }),
  ),
  resource("liveBroadcasts.insert", (native) =>
    native.liveBroadcasts({
      action: "insert",
      body: { snippet: { title: "Live" }, status: { privacyStatus: "private" } },
      context: context(),
    }),
  ),
  resource("liveBroadcasts.cuepoint", (native) =>
    native.liveBroadcasts({
      action: "cuepoint",
      id: "broadcast1",
      cuepoint: { durationSecs: 30 },
      context: context(),
    }),
  ),
  resource("liveStreams.insert", (native) =>
    native.liveStreams({
      action: "insert",
      body: {
        snippet: { title: "Stream" },
        cdn: { ingestionType: "rtmp", resolution: "variable", frameRate: "variable" },
      },
      context: context(),
    }),
  ),
  resource("liveChatMessages.insert", (native) =>
    native.liveChatMessages({
      action: "insert",
      body: { snippet: { liveChatId: "chat1", type: "textMessageEvent" } },
      context: context(),
    }),
  ),
  resource("liveChatModerators.insert", (native) =>
    native.liveChatModerators({
      action: "insert",
      body: { snippet: { liveChatId: "chat1", moderatorDetails: {} } },
      context: context(),
    }),
  ),
  resource("liveChatBans.insert", (native) =>
    native.liveChatBans({
      action: "insert",
      body: { snippet: { liveChatId: "chat1", type: "permanent" } },
      context: context(),
    }),
  ),
  resource("channelSections.insert", (native) =>
    native.channelSections({
      action: "insert",
      body: { snippet: { type: "recentUploads" } },
      context: context(),
    }),
  ),
  resource("playlistImages.insert", (native) =>
    native.playlistImages({ action: "insert", playlistId: "p1", image, context: context() }),
  ),
  resource("analyticsGroups.insert", (native) =>
    native.analyticsGroups({
      action: "insert",
      title: "Group",
      itemType: "youtube#video",
      context: context(),
    }),
  ),
  resource("reportingJobs.create", (native) =>
    native.reportingJobs({
      action: "create",
      reportTypeId: "channel_basic_a2",
      name: "Job",
      context: context(),
    }),
  ),
  {
    name: "analyticsGroupItems.insert",
    run: (native) =>
      native.analyticsGroupItems({
        action: "insert",
        groupId: "group1",
        resource: { kind: "youtube#video", id: "video1" },
        context: context(),
      }),
    // https://developers.google.com/youtube/analytics/reference/groupItems/insert#response
    valid: [json("inserted groupItem", { id: "item1" }), noContent],
    malformed: notResources.filter((answer) => answer !== noContent),
  },
  // Native updates, which must answer with the addressed resource.
  update("playlists.update", "playlist1", (native) =>
    native.playlists({
      action: "update",
      playlistId: "playlist1",
      body: { snippet: { title: "A" } },
      context: context(),
    }),
  ),
  update("playlistItems.update", "item1", (native) =>
    native.playlistItems({
      action: "update",
      playlistItemId: "item1",
      body: {
        snippet: { playlistId: "p1", resourceId: { kind: "youtube#video", videoId: "v1" } },
      },
      context: context(),
    }),
  ),
  update("captions.update", "caption1", (native) =>
    native.captions({
      action: "update",
      videoId: "video1",
      captionId: "caption1",
      body: { snippet: { isDraft: true } },
      context: context(),
    }),
  ),
  update("videos.update", "video1", (native) =>
    native.updateVideo({
      videoId: "video1",
      body: { snippet: { title: "New" } },
      context: context(),
    }),
  ),
  update("channels.update", "channel1", (native) =>
    native.updateProfile({
      part: "localizations",
      value: { fr: { title: "Chaîne" } },
      context: context(),
    }),
  ),
  update("comments.update", "comment1", (native) =>
    native.commentsModeration({
      action: "update",
      commentId: "comment1",
      body: { snippet: { textOriginal: "Edited" } },
      context: context(),
    }),
  ),
  update("liveBroadcasts.update", "broadcast1", (native) =>
    native.liveBroadcasts({
      action: "update",
      id: "broadcast1",
      body: { snippet: { title: "Live" } },
      context: context(),
    }),
  ),
  update("liveStreams.update", "stream1", (native) =>
    native.liveStreams({
      action: "update",
      streamId: "stream1",
      body: { snippet: { title: "Stream" } },
      context: context(),
    }),
  ),
  update("channelSections.update", "section1", (native) =>
    native.channelSections({
      action: "update",
      channelSectionId: "section1",
      body: { snippet: { type: "singlePlaylist" } },
      context: context(),
    }),
  ),
  update("playlistImages.update", "image1", (native) =>
    native.playlistImages({
      action: "update",
      playlistImageId: "image1",
      playlistId: "p1",
      image,
      context: context(),
    }),
  ),
  update("analyticsGroups.update", "group1", (native) =>
    native.analyticsGroups({
      action: "update",
      groupId: "group1",
      title: "Group",
      context: context(),
    }),
  ),
  update("liveChatMessages.closePoll", "poll1", (native) =>
    native.liveChatMessages({ action: "closePoll", messageId: "poll1", context: context() }),
  ),
  // Writes whose answer must report a specific state.
  {
    name: "liveBroadcasts.bind",
    run: (native) =>
      native.liveBroadcasts({
        action: "bind",
        id: "broadcast1",
        streamId: "stream1",
        context: context(),
      }),
    valid: [json("bound", { id: "broadcast1", contentDetails: { boundStreamId: "stream1" } })],
    malformed: [
      ...notResources,
      json("null contentDetails", { id: "broadcast1", contentDetails: null }),
      json("numeric contentDetails", { id: "broadcast1", contentDetails: 7 }),
      json("array contentDetails", { id: "broadcast1", contentDetails: [] }),
      json("another stream", { id: "broadcast1", contentDetails: { boundStreamId: "other" } }),
    ],
  },
  {
    // https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/bind
    name: "liveBroadcasts.bind (unbind)",
    run: (native) =>
      native.liveBroadcasts({ action: "bind", id: "broadcast1", context: context() }),
    valid: [
      json("unbound", { id: "broadcast1", contentDetails: {} }),
      json("unbound without the part", { id: "broadcast1" }),
    ],
    malformed: [
      ...notResources,
      json("null contentDetails", { id: "broadcast1", contentDetails: null }),
      json("numeric contentDetails", { id: "broadcast1", contentDetails: 7 }),
      json("array contentDetails", { id: "broadcast1", contentDetails: [] }),
      json("still bound", { id: "broadcast1", contentDetails: { boundStreamId: "stream1" } }),
    ],
  },
  {
    name: "liveBroadcasts.transition",
    run: (native) =>
      native.liveBroadcasts({
        action: "transition",
        id: "broadcast1",
        broadcastStatus: "live",
        context: context(),
      }),
    valid: [json("live", { id: "broadcast1", status: { lifeCycleStatus: "live" } })],
    malformed: [
      ...notResources,
      json("null status", { id: "broadcast1", status: null }),
      json("numeric lifeCycleStatus", { id: "broadcast1", status: { lifeCycleStatus: 7 } }),
      json("not transitioned", { id: "broadcast1", status: { lifeCycleStatus: "ready" } }),
    ],
  },
  {
    name: "thumbnails.set",
    run: (native) =>
      native.setThumbnail({ videoId: "video1", thumbnail: image, context: context() }),
    valid: [json("stored thumbnails", { items: [{ default: { url: "https://i.ytimg.com/x" } }] })],
    malformed: [
      json("JSON null", null),
      json("array", []),
      json("empty object", {}),
      json("empty items", { items: [] }),
      json("scalar item", { items: [7] }),
      json("object items", { items: {} }),
      noContent,
    ],
  },
  {
    name: "channelBanners.insert",
    run: (native) => native.uploadChannelBanner({ image, context: context() }),
    valid: [json("banner", { url: "https://yt3.ggpht.com/banner" })],
    malformed: [
      json("JSON null", null),
      json("array", []),
      json("empty object", {}),
      json("numeric url", { url: 7 }),
      json("blank url", { url: "" }),
      noContent,
    ],
  },
  {
    name: "abuseReports.insert",
    run: (native) =>
      native.abuseReports({
        report: { subject: { id: "comment1", typeId: "comment" }, abuseTypes: [{ id: "spam" }] },
        context: context(),
      }),
    valid: [json("stored report", { subject: { id: "comment1", typeId: "comment" } })],
    malformed: [
      json("JSON null", null),
      json("array", []),
      json("empty object", {}),
      json("null subject", { subject: null }),
      json("scalar subject", { subject: "comment1" }),
      noContent,
    ],
  },
  // Writes documented as 204 No Content.
  empty("videos.delete", (native) => native.deleteVideo({ videoId: "video1", context: context() })),
  empty("videos.rate", (native) =>
    native.rateVideo({ videoId: "video1", rating: "like", context: context() }),
  ),
  empty("videos.reportAbuse", (native) =>
    native.reportAbuse({ videoId: "video1", reasonId: "S", context: context() }),
  ),
  empty("captions.delete", (native) =>
    native.captions({
      action: "delete",
      videoId: "video1",
      captionId: "caption1",
      context: context(),
    }),
  ),
  empty("playlists.delete", (native) =>
    native.playlists({ action: "delete", playlistId: "playlist1", context: context() }),
  ),
  empty("playlistItems.delete", (native) =>
    native.playlistItems({ action: "delete", playlistItemId: "item1", context: context() }),
  ),
  empty("subscriptions.delete", (native) =>
    native.subscriptions({ action: "delete", subscriptionId: "sub1", context: context() }),
  ),
  empty("comments.setModerationStatus", (native) =>
    native.commentsModeration({
      action: "setModerationStatus",
      commentId: "comment1",
      moderationStatus: "published",
      context: context(),
    }),
  ),
  empty("comments.delete (moderation)", (native) =>
    native.commentsModeration({ action: "delete", commentId: "comment1", context: context() }),
  ),
  empty("comments.delete", (native) =>
    native.deleteComment({
      account: {
        kind: "connected-account",
        version: 1,
        backend: "default",
        platform: "youtube",
        accountId: "channel1",
      },
      commentId: "comment1",
      context: context(),
    }),
  ),
  empty("liveBroadcasts.delete", (native) =>
    native.liveBroadcasts({ action: "delete", id: "broadcast1", context: context() }),
  ),
  empty("liveStreams.delete", (native) =>
    native.liveStreams({ action: "delete", streamId: "stream1", context: context() }),
  ),
  empty("liveChatMessages.delete", (native) =>
    native.liveChatMessages({
      action: "delete",
      liveChatId: "chat1",
      messageId: "message1",
      context: context(),
    }),
  ),
  empty("liveChatModerators.delete", (native) =>
    native.liveChatModerators({
      action: "delete",
      liveChatId: "chat1",
      moderatorId: "moderator1",
      context: context(),
    }),
  ),
  empty("liveChatBans.delete", (native) =>
    native.liveChatBans({ action: "delete", banId: "ban1", context: context() }),
  ),
  empty("channelSections.delete", (native) =>
    native.channelSections({ action: "delete", channelSectionId: "section1", context: context() }),
  ),
  empty("playlistImages.delete", (native) =>
    native.playlistImages({ action: "delete", playlistImageId: "image1", context: context() }),
  ),
  empty("analyticsGroups.delete", (native) =>
    native.analyticsGroups({ action: "delete", groupId: "group1", context: context() }),
  ),
  empty("analyticsGroupItems.delete", (native) =>
    native.analyticsGroupItems({ action: "delete", groupItemId: "item1", context: context() }),
  ),
  empty("watermarks.set", (native) =>
    native.watermarks({
      action: "set",
      image,
      timing: { type: "offsetFromStart", offsetMs: 0 },
      context: context(),
    }),
  ),
  empty("watermarks.unset", (native) => native.watermarks({ action: "unset", context: context() })),
  {
    // https://developers.google.com/youtube/reporting/v1/reference/rest/v1/jobs/delete
    name: "reportingJobs.delete",
    run: (native) => native.reportingJobs({ action: "delete", jobId: "job1", context: context() }),
    valid: [json("empty message", {}), noContent],
    malformed: [json("JSON null", null), json("array", []), json("a resource", { id: "job1" })],
  },
];

for (const write of writes) {
  for (const answer of write.malformed)
    it(`YouTube ${write.name} keeps a ${answer.name} answer uncertain after one write`, async () => {
      const { adapter, writes: sent } = setup(answer);

      try {
        await assert.rejects(write.run(nativeOf(adapter), adapter), uncertain);
      } finally {
        assert.equal(sent(), 1);
      }
    });

  for (const answer of write.valid)
    it(`YouTube ${write.name} confirms its documented ${answer.name} after one write`, async () => {
      const { adapter, writes: sent } = setup(answer);

      await write.run(nativeOf(adapter), adapter);
      assert.equal(sent(), 1);
    });
}

/** The final upload chunk's answer is the created video: a non-empty ID, and a well-formed status when present. */
const uploads: readonly { readonly answer: Answer; readonly confirmed: boolean }[] = [
  {
    answer: json("video", { id: "video1", status: { uploadStatus: "uploaded" } }),
    confirmed: true,
  },
  { answer: json("JSON null", null), confirmed: false },
  { answer: json("array", []), confirmed: false },
  { answer: json("empty object", {}), confirmed: false },
  { answer: json("numeric id", { id: 7, status: {} }), confirmed: false },
  // A session opened with part=snippet answers without a status part; the ID alone confirms it.
  { answer: json("no status part", { id: "video1" }), confirmed: true },
  { answer: json("null status", { id: "video1", status: null }), confirmed: false },
  {
    answer: json("numeric uploadStatus", { id: "video1", status: { uploadStatus: 7 } }),
    confirmed: false,
  },
  {
    answer: { name: "201 without a body", respond: () => new Response(null, { status: 201 }) },
    confirmed: false,
  },
];

for (const { answer, confirmed } of uploads)
  it(`YouTube upload ${confirmed ? "confirms" : "keeps uncertain"} a final ${answer.name} answer after one write`, async () => {
    let writes = 0;

    const sent = sendYouTubeUpload(
      {
        url: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=u1",
        size: 1,
        mimeType: "video/mp4",
        channelId: "channel1",
      },
      {
        kind: "video",
        mimeType: "video/mp4",
        source: { kind: "blob", blob: new Blob(["x"]), fingerprint: "upload" },
      },
      {
        accessToken: "fixture-only",
        timeoutMs: 5000,
        fetch: async () => {
          writes++;

          return answer.respond();
        },
      },
    );

    try {
      if (confirmed) assert.equal((await sent).state, "complete");
      else await assert.rejects(sent, uncertain);
    } finally {
      assert.equal(writes, 1);
    }
  });

// Council round 4 regressions, ported from the reviewer's repro.
for (const contentDetails of [null, 7, []])
  it(`unbind keeps malformed contentDetails=${JSON.stringify(contentDetails)} uncertain`, async () => {
    const { adapter, writes: sent } = setup(
      json("broadcast", { id: "broadcast1", contentDetails }),
    );

    try {
      await assert.rejects(
        nativeOf(adapter).liveBroadcasts({ action: "bind", id: "broadcast1", context: context() }),
        uncertain,
      );
    } finally {
      assert.equal(sent(), 1);
    }
  });

it("groupItems insert keeps HTTP 200 JSON null uncertain", async () => {
  const { adapter, writes: sent } = setup(json("JSON null", null));

  try {
    await assert.rejects(
      nativeOf(adapter).analyticsGroupItems({
        action: "insert",
        groupId: "group1",
        resource: { kind: "youtube#video", id: "video1" },
        context: context(),
      }),
      uncertain,
    );
  } finally {
    assert.equal(sent(), 1);
  }
});

it("control: groupItems HTTP 204 confirms existing membership", async () => {
  const { adapter } = setup(noContent);

  assert.deepEqual(
    await nativeOf(adapter).analyticsGroupItems({
      action: "insert",
      groupId: "group1",
      resource: { kind: "youtube#video", id: "video1" },
      context: context(),
    }),
    { alreadyInGroup: true },
  );
});
