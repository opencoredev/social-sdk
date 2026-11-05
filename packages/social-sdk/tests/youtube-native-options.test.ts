import { it } from "node:test";
import assert from "node:assert/strict";
import type { AdapterOperationContext } from "../src/index.js";
import { youtube } from "../src/platforms/youtube.js";
import { revokeGoogleOAuthToken, youtubeOAuth } from "../src/server/oauth.js";
import type { JsonValue } from "../src/core/types.js";
import { parseJson } from "../src/transport/json.js";

const context = (): AdapterOperationContext => ({
  backendInstance: "default",
  correlationId: "native-options",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
});

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly body?: JsonValue;
}

/** A fake fetch that records each request and answers from `respond`. */
function nativeFor(respond: (call: Call) => Response = () => Response.json({ items: [] })) {
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

  const adapter = youtube({ auth: { accessToken: "test", channelId: "channel1" }, fetch });

  return { calls, native: adapter.native! };
}

const query = (call: Call | undefined): Record<string, string> =>
  Object.fromEntries(call?.url.searchParams ?? []);

it("liveBroadcasts list sends broadcastStatus, broadcastType, maxResults and pageToken", async () => {
  const { calls, native } = nativeFor();

  await native.liveBroadcasts({
    action: "list",
    statusFilter: "upcoming",
    broadcastType: "persistent",
    maxResults: 50,
    pageToken: "next",
    context: context(),
  });

  await native.liveBroadcasts({ action: "list", broadcastType: "all", context: context() });

  assert.equal(calls[0]?.url.pathname, "/youtube/v3/liveBroadcasts");
  assert.deepEqual(query(calls[0]), {
    part: "snippet,status,contentDetails",
    broadcastStatus: "upcoming",
    broadcastType: "persistent",
    maxResults: "50",
    pageToken: "next",
  });
  assert.deepEqual(query(calls[1]), {
    part: "snippet,status,contentDetails",
    mine: "true",
    broadcastType: "all",
  });

  await assert.rejects(
    native.liveBroadcasts({ action: "list", id: "b1", statusFilter: "all", context: context() }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    native.liveBroadcasts({ action: "list", maxResults: 51, context: context() }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    native.liveBroadcasts({ action: "delete", id: "b1", broadcastType: "all", context: context() }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 2);
});

it("liveChatMessages list sends hl and profileImageSize", async () => {
  const { calls, native } = nativeFor(() =>
    Response.json({ items: [], pollingIntervalMillis: 2000 }),
  );

  const result = await native.liveChatMessages({
    action: "list",
    liveChatId: "chat1",
    hl: "de",
    profileImageSize: 240,
    context: context(),
  });

  assert.equal(calls[0]?.url.pathname, "/youtube/v3/liveChat/messages");
  assert.deepEqual(query(calls[0]), {
    liveChatId: "chat1",
    part: "snippet,authorDetails",
    hl: "de",
    profileImageSize: "240",
  });
  assert.deepEqual(result, { items: [], pollingIntervalMillis: 2000 });

  await assert.rejects(
    native.liveChatMessages({
      action: "list",
      liveChatId: "chat1",
      profileImageSize: 721,
      context: context(),
    }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 1);
});

it("liveChatMessages closePoll posts to /liveChat/messages/transition with status=closed", async () => {
  const poll = {
    id: "poll1",
    snippet: {
      type: "pollEvent",
      pollDetails: {
        metadata: { questionText: "Next topic?", options: [{ optionText: "A", tally: "12" }] },
        status: "closed",
      },
    },
  };

  const { calls, native } = nativeFor(() => Response.json(poll));

  const result = await native.liveChatMessages({
    action: "closePoll",
    messageId: "poll1",
    context: context(),
  });

  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url.pathname, "/youtube/v3/liveChat/messages/transition");
  assert.deepEqual(query(calls[0]), { id: "poll1", status: "closed", part: "snippet" });
  assert.deepEqual(result, poll);

  await assert.rejects(native.liveChatMessages({ action: "closePoll", context: context() }), {
    code: "invalid_input",
  });
  assert.equal(calls.length, 1);
});

it("search sends videoEmbeddable, videoSyndicated, videoDimension, videoPaidProductPlacement and channelType", async () => {
  const { calls, native } = nativeFor();

  await native.search({
    q: "launch",
    type: "video",
    videoEmbeddable: "true",
    videoSyndicated: "true",
    videoDimension: "3d",
    videoPaidProductPlacement: "true",
    context: context(),
  });

  await native.search({ q: "podcast", type: "channel", channelType: "show", context: context() });

  assert.deepEqual(query(calls[0]), {
    part: "snippet",
    q: "launch",
    type: "video",
    videoEmbeddable: "true",
    videoSyndicated: "true",
    videoDimension: "3d",
    videoPaidProductPlacement: "true",
  });
  assert.deepEqual(query(calls[1]), {
    part: "snippet",
    q: "podcast",
    type: "channel",
    channelType: "show",
  });

  await assert.rejects(
    native.search({ q: "x", type: "channel", videoEmbeddable: "true", context: context() }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 2);
});

it("search sends forMine with type=video and forDeveloper with q", async () => {
  const { calls, native } = nativeFor();

  await native.search({ q: "draft", type: "video", forMine: true, context: context() });

  await native.search({ q: "app", forDeveloper: true, context: context() });

  assert.deepEqual(query(calls[0]), {
    part: "snippet",
    q: "draft",
    type: "video",
    forMine: "true",
  });
  assert.deepEqual(query(calls[1]), { part: "snippet", q: "app", forDeveloper: "true" });

  await assert.rejects(native.search({ q: "x", forMine: true, context: context() }), {
    code: "invalid_input",
  });
  await assert.rejects(
    native.search({
      q: "x",
      type: "video",
      forMine: true,
      videoDuration: "short",
      context: context(),
    }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    native.search({ q: "x", type: "video", forMine: true, forDeveloper: true, context: context() }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 2);
});

it("captions download sends tfmt and tlang, or no tfmt for the original format [feature:youtube.media.captions.download_options]", async () => {
  const { calls, native } = nativeFor(
    () => new Response("1\n00:00:00,000 --> 00:00:01,000\nBonjour\n", { status: 200 }),
  );

  const file = await native.captions({
    action: "download",
    videoId: "video1",
    captionId: "cap1",
    format: "srt",
    tlang: "fr",
    context: context(),
  });

  await native.captions({
    action: "download",
    videoId: "video1",
    captionId: "cap1",
    format: "original",
    context: context(),
  });

  await native.captions({
    action: "download",
    videoId: "video1",
    captionId: "cap1",
    context: context(),
  });

  assert.equal(calls[0]?.url.pathname, "/youtube/v3/captions/cap1");
  assert.deepEqual(query(calls[0]), { tfmt: "srt", tlang: "fr" });
  assert.deepEqual(query(calls[1]), {});
  assert.deepEqual(query(calls[2]), { tfmt: "vtt" });
  assert.ok(file instanceof Blob);
  assert.equal(await file.text(), "1\n00:00:00,000 --> 00:00:01,000\nBonjour\n");

  await assert.rejects(
    native.captions({
      action: "download",
      videoId: "video1",
      captionId: "cap1",
      tlang: "not a language",
      context: context(),
    }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 3);
});

it("videos sends maxWidth and maxHeight with the player part", async () => {
  const { calls, native } = nativeFor(() =>
    Response.json({
      items: [
        { id: "v1", player: { embedHtml: "<iframe>", embedWidth: "640", embedHeight: "360" } },
      ],
    }),
  );

  const result = await native.videos({
    filter: { kind: "id", ids: ["v1"] },
    parts: ["player"],
    maxWidth: 640,
    maxHeight: 480,
    context: context(),
  });

  assert.deepEqual(query(calls[0]), {
    part: "player",
    id: "v1",
    maxWidth: "640",
    maxHeight: "480",
  });
  assert.deepEqual(result["items"], [
    { id: "v1", player: { embedHtml: "<iframe>", embedWidth: "640", embedHeight: "360" } },
  ]);

  await assert.rejects(
    native.videos({ filter: { kind: "id", ids: ["v1"] }, maxWidth: 640, context: context() }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    native.videos({
      filter: { kind: "id", ids: ["v1"] },
      parts: ["player"],
      maxHeight: 50,
      context: context(),
    }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 1);
});

it("comments looks up comments by ID with comments.list id [feature:youtube.comments.lookup_by_id]", async () => {
  const { calls, native } = nativeFor(() =>
    Response.json({ items: [{ id: "c1", snippet: { textDisplay: "Hi", parentId: "t1" } }] }),
  );

  const result = await native.comments({
    commentIds: ["c1", "c2"],
    textFormat: "plainText",
    context: context(),
  });

  assert.equal(calls[0]?.url.pathname, "/youtube/v3/comments");
  assert.deepEqual(query(calls[0]), { part: "snippet", id: "c1,c2", textFormat: "plainText" });
  assert.deepEqual(result["items"], [{ id: "c1", snippet: { textDisplay: "Hi", parentId: "t1" } }]);

  await assert.rejects(native.comments({ commentIds: [], context: context() }), {
    code: "invalid_input",
  });
  assert.equal(calls.length, 1);
});

it("channelSections lists another channel's sections with hl [feature:youtube.account.channelSections.other_channels]", async () => {
  const { calls, native } = nativeFor(() =>
    Response.json({ items: [{ id: "s1", snippet: { channelId: "other", localized: {} } }] }),
  );

  const result = await native.channelSections({
    action: "list",
    channelId: "other",
    hl: "es",
    context: context(),
  });

  assert.equal(calls[0]?.url.pathname, "/youtube/v3/channelSections");
  assert.deepEqual(query(calls[0]), {
    part: "snippet,contentDetails",
    channelId: "other",
    hl: "es",
  });
  assert.deepEqual(result, {
    items: [{ id: "s1", snippet: { channelId: "other", localized: {} } }],
  });

  await assert.rejects(
    native.channelSections({
      action: "list",
      channelId: "other",
      channelSectionId: "s1",
      context: context(),
    }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    native.channelSections({ action: "delete", channelId: "other", context: context() }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 1);
});

it("videoTrainability reads /youtube/v3/videoTrainability and decodes permitted", async () => {
  const { calls, native } = nativeFor(() =>
    Response.json({
      kind: "youtube#videoTrainability",
      etag: "e",
      videoId: "v1",
      permitted: ["all"],
    }),
  );

  const result = await native.videoTrainability({ videoId: "v1", context: context() });

  assert.equal(calls[0]?.url.pathname, "/youtube/v3/videoTrainability");
  assert.deepEqual(query(calls[0]), { id: "v1" });
  assert.equal(result.videoId, "v1");
  assert.deepEqual(result.permitted, ["all"]);

  const malformed = nativeFor(() => Response.json({ videoId: "v1", permitted: [3] }));

  await assert.rejects(malformed.native.videoTrainability({ videoId: "v1", context: context() }));
});

it("abuseReports posts an AbuseReport body to /youtube/v3/abuseReports", async () => {
  const { calls, native } = nativeFor((call) => Response.json(call.body ?? {}));

  const result = await native.abuseReports({
    report: {
      subject: { id: "comment1", typeId: "comment" },
      abuseTypes: [{ id: "spam" }],
      description: "Repeated link spam",
      relatedEntities: [{ entity: { id: "channel9", typeId: "channel" } }],
    },
    context: context(),
  });

  const expected = {
    subject: { id: "comment1", typeId: "comment" },
    abuseTypes: [{ id: "spam" }],
    description: "Repeated link spam",
    relatedEntities: [{ entity: { id: "channel9", typeId: "channel" } }],
  };

  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url.pathname, "/youtube/v3/abuseReports");
  assert.deepEqual(query(calls[0]), {
    part: "subject,abuseTypes,description,relatedEntities",
  });
  assert.deepEqual(calls[0]?.body, expected);
  assert.deepEqual(result, expected);

  await assert.rejects(
    native.abuseReports({
      report: { subject: {}, abuseTypes: [{ id: "spam" }] },
      context: context(),
    }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    native.abuseReports({ report: { subject: { id: "c1" }, abuseTypes: [] }, context: context() }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 1);
});

it("youtubeOAuth adds include_granted_scopes and login_hint to the Google authorize URL", async () => {
  const provider = youtubeOAuth({ clientId: "client", includeGrantedScopes: true });

  const start: Parameters<typeof provider.start>[0] = {
    platforms: ["youtube"],
    capabilities: [],
    redirectUri: "https://app.test/cb",
    state: "state",
    codeChallenge: "challenge",
  };

  const hinted = new URL(
    (await provider.start({ ...start, loginHint: "creator@example.com" })).authorizationUrl,
  );

  assert.equal(hinted.searchParams.get("include_granted_scopes"), "true");
  assert.equal(hinted.searchParams.get("login_hint"), "creator@example.com");
  assert.equal(hinted.searchParams.get("access_type"), "offline");

  const plain = new URL((await youtubeOAuth({ clientId: "client" }).start(start)).authorizationUrl);

  assert.equal(plain.searchParams.has("include_granted_scopes"), false);
  assert.equal(plain.searchParams.has("login_hint"), false);
});

it("revokeGoogleOAuthToken posts the token form to oauth2.googleapis.com/revoke", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];

  const result = await revokeGoogleOAuthToken(
    {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });

        return new Response(null, { status: 200 });
      },
    },
    { token: "refresh-token" },
  );

  assert.equal(result, "revoked");
  assert.equal(calls[0]?.url, "https://oauth2.googleapis.com/revoke");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(
    new Headers(calls[0]?.init?.headers).get("content-type"),
    "application/x-www-form-urlencoded",
  );
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[0]?.init?.body))), {
    token: "refresh-token",
  });

  await assert.rejects(
    revokeGoogleOAuthToken(
      { fetch: async () => Response.json({ error: "invalid_token" }, { status: 400 }) },
      { token: "stale" },
    ),
    { code: "upstream_failure" },
  );
});
