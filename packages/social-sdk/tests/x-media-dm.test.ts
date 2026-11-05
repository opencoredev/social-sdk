import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, SocialError, type AdapterOperationContext } from "../src/index.js";
import type { JsonValue } from "../src/core/types.js";
import { isJsonObject } from "../src/transport/validation.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "x-media-dm",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

interface Seen {
  readonly method: string;
  readonly href: string;
  readonly body: JsonValue | undefined;
}

type Route = (body: JsonValue | undefined) => Response;

function fake(routes: Readonly<Record<string, Route>>) {
  const seen: Seen[] = [];

  const adapter = x({
    auth: { userId: "11", accessToken: "user" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      const body =
        init?.body === undefined || init.body instanceof FormData
          ? undefined
          : JSON.parse(String(init.body));

      seen.push({ method, href: url.href, body });

      if (url.pathname.endsWith("/append")) return new Response(null, { status: 204 });

      const route = routes[`${method} ${url.pathname}`];

      return route === undefined ? Response.json({}, { status: 404 }) : route(body);
    },
  });

  assert.ok(adapter.native);

  return { native: adapter.native, seen };
}

const chunked = {
  "POST /2/media/upload/initialize": () => Response.json({ data: { id: "801" } }),
  "POST /2/media/upload/801/finalize": () => Response.json({ data: { id: "801" } }),
} satisfies Readonly<Record<string, Route>>;

it("uploads DM media with dm_image and additional_owners [feature:x.media.dm_upload] [feature:x.media.additional_owners]", async () => {
  const { native, seen } = fake(chunked);

  const uploaded = await native.uploadDmMedia({
    account,
    media: new Blob([new Uint8Array(64)], { type: "image/png" }),
    kind: "image",
    additionalOwners: ["12"],
    context,
  });

  assert.deepEqual(uploaded, { mediaId: "801" });
  assert.deepEqual(seen[0], {
    method: "POST",
    href: "https://api.x.com/2/media/upload/initialize",
    body: {
      media_category: "dm_image",
      media_type: "image/png",
      total_bytes: 64,
      additional_owners: ["12"],
    },
  });
  assert.deepEqual(
    seen.map((entry) => new URL(entry.href).pathname),
    ["/2/media/upload/initialize", "/2/media/upload/801/append", "/2/media/upload/801/finalize"],
  );

  const video = fake(chunked);
  await video.native.uploadDmMedia({
    account,
    media: new Blob([new Uint8Array(8)], { type: "video/mp4" }),
    kind: "video",
    context,
  });

  const init = video.seen[0]?.body;

  assert.ok(isJsonObject(init));
  assert.equal(init["media_category"], "dm_video");

  await assert.rejects(
    native.uploadDmMedia({
      account,
      media: new Blob([new Uint8Array(6 * 1024 * 1024)], { type: "image/png" }),
      kind: "image",
      context,
    }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    native.uploadDmMedia({
      account,
      media: new Blob([new Uint8Array(8)], { type: "image/png" }),
      kind: "gif",
      context,
    }),
    { code: "invalid_input" },
  );
});

it("shares a native video upload with additional_owners", async () => {
  const { native, seen } = fake(chunked);

  await native.uploadVideo({
    account,
    video: new Blob([new Uint8Array(16)], { type: "video/mp4" }),
    additionalOwners: ["12", "13"],
    context,
  });

  assert.deepEqual(seen[0]?.body, {
    media_category: "tweet_video",
    media_type: "video/mp4",
    total_bytes: 16,
    additional_owners: ["12", "13"],
  });
  await assert.rejects(
    native.uploadGif({
      account,
      gif: new Blob([new Uint8Array(8)], { type: "image/gif" }),
      additionalOwners: ["owner"],
      context,
    }),
    { code: "invalid_input" },
  );
});

it("uploads, attaches and deletes subtitles with /2/media/subtitles [feature:x.media.subtitles]", async () => {
  const { native, seen } = fake({
    ...chunked,
    "POST /2/media/subtitles": () =>
      Response.json({
        data: { id: "700", media_category: "TweetVideo", associated_subtitles: {} },
      }),
    "DELETE /2/media/subtitles": () => Response.json({ data: { deleted: true } }),
  });

  const track = await native.uploadSubtitles({
    account,
    file: new Blob(["1\n00:00:00,000 --> 00:00:01,000\nHello\n"], { type: "text/plain" }),
    format: "srt",
    context,
  });

  assert.deepEqual(track, { mediaId: "801" });
  assert.deepEqual(seen[0]?.body, {
    media_category: "subtitles",
    media_type: "text/srt",
    total_bytes: 38,
  });

  const attached = await native.attachSubtitles({
    account,
    videoMediaId: "700",
    subtitleMediaId: track.mediaId,
    languageCode: "EN",
    displayName: "English",
    context,
  });

  assert.deepEqual(attached, { id: "700", media_category: "TweetVideo", associated_subtitles: {} });
  assert.deepEqual(seen[3], {
    method: "POST",
    href: "https://api.x.com/2/media/subtitles",
    body: {
      id: "700",
      media_category: "TweetVideo",
      subtitles: { id: "801", language_code: "EN", display_name: "English" },
    },
  });

  await native.deleteSubtitles({ account, videoMediaId: "700", languageCode: "EN", context });
  assert.deepEqual(seen[4], {
    method: "DELETE",
    href: "https://api.x.com/2/media/subtitles",
    body: { id: "700", media_category: "TweetVideo", language_code: "EN" },
  });

  await assert.rejects(
    native.attachSubtitles({
      account,
      videoMediaId: "700",
      subtitleMediaId: "801",
      languageCode: "en-US",
      context,
    }),
    { code: "invalid_input" },
  );

  const unconfirmed = fake({ "DELETE /2/media/subtitles": () => Response.json({ data: {} }) });
  await assert.rejects(
    unconfirmed.native.deleteSubtitles({
      account,
      videoMediaId: "700",
      languageCode: "EN",
      context,
    }),
    { code: "ambiguous_outcome" },
  );
});

it("requests non_public_metrics and organic_metrics for owned Posts [feature:x.analytics.private_metrics]", async () => {
  const { native, seen } = fake({
    "GET /2/tweets": () =>
      Response.json({
        data: [
          {
            id: "1",
            author_id: "11",
            non_public_metrics: { impression_count: 900, url_link_clicks: 12 },
            organic_metrics: { impression_count: 880, like_count: 30, retweet_count: 2 },
          },
        ],
      }),
  });

  assert.deepEqual(await native.privatePostMetrics({ account, postIds: ["1"], context }), [
    {
      postId: "1",
      nonPublic: { impression_count: 900, url_link_clicks: 12 },
      organic: { impression_count: 880, like_count: 30, retweet_count: 2 },
    },
  ]);
  assert.equal(
    seen[0]?.href,
    "https://api.x.com/2/tweets?ids=1&tweet.fields=id%2Cauthor_id%2Cnon_public_metrics%2Corganic_metrics",
  );

  const foreign = fake({
    "GET /2/tweets": () => Response.json({ data: [{ id: "2", author_id: "99" }] }),
  });

  await assert.rejects(foreign.native.privatePostMetrics({ account, postIds: ["2"], context }), {
    code: "unauthorized",
  });
});

it("reads Post analytics and media analytics time series [feature:x.analytics.post_analytics] [feature:x.analytics.media]", async () => {
  const { native, seen } = fake({
    "GET /2/tweets/analytics": () =>
      Response.json({ data: [{ id: "1", impressions: 1200, url_clicks: 14 }] }),
    "GET /2/media/analytics": () =>
      Response.json({ data: [{ media_key: "7_1", video_views: 300, playback_complete: 40 }] }),
  });

  const posts = await native.postAnalytics({
    account,
    postIds: ["1"],
    startTime: "2026-11-01T00:00:00Z",
    endTime: "2026-11-04T00:00:00Z",
    granularity: "daily",
    fields: ["impressions", "url_clicks"],
    context,
  });

  assert.deepEqual(posts.items, [{ id: "1", impressions: 1200, url_clicks: 14 }]);
  assert.equal(
    seen[0]?.href,
    "https://api.x.com/2/tweets/analytics?ids=1&start_time=2026-11-01T00%3A00%3A00Z&end_time=2026-11-04T00%3A00%3A00Z&granularity=daily&analytics.fields=impressions%2Curl_clicks",
  );

  const media = await native.mediaAnalytics({
    account,
    mediaKeys: ["7_1"],
    startTime: "2026-11-01T00:00:00Z",
    endTime: "2026-11-04T00:00:00Z",
    fields: ["video_views", "playback_complete"],
    context,
  });

  assert.deepEqual(media.items, [{ media_key: "7_1", video_views: 300, playback_complete: 40 }]);
  assert.equal(new URL(seen[1]?.href ?? "").pathname, "/2/media/analytics");
  assert.equal(
    new URL(seen[1]?.href ?? "").searchParams.get("media_analytics.fields"),
    "video_views,playback_complete",
  );

  await assert.rejects(
    native.postAnalytics({
      account,
      postIds: ["1"],
      startTime: "2026-11-04T00:00:00Z",
      endTime: "2026-11-01T00:00:00Z",
      context,
    }),
    { code: "invalid_input" },
  );
});

it("reads and deletes one DM event with /2/dm_events/{id} [feature:x.dm.event_lookup_delete]", async () => {
  const { native, seen } = fake({
    "GET /2/dm_events/123": () =>
      Response.json({ data: { id: "123", event_type: "MessageCreate", text: "hi" } }),
    "DELETE /2/dm_events/123": () => Response.json({ data: { deleted: true } }),
  });

  assert.deepEqual(await native.getDirectMessage({ account, eventId: "123", context }), {
    data: { id: "123", event_type: "MessageCreate", text: "hi" },
  });
  assert.equal(new URL(seen[0]?.href ?? "").pathname, "/2/dm_events/123");

  await native.deleteDirectMessage({ account, eventId: "123", context });
  assert.deepEqual(seen[1], {
    method: "DELETE",
    href: "https://api.x.com/2/dm_events/123",
    body: undefined,
  });
});

it("blocks and unblocks DMs with /2/users/{id}/dm/block [feature:x.dm.block]", async () => {
  const { native, seen } = fake({
    "POST /2/users/12/dm/block": () => Response.json({ data: { blocked: true } }),
    "POST /2/users/12/dm/unblock": () => Response.json({ data: { blocked: false } }),
  });

  await native.blockDms({ account, userId: "12", context });
  await native.unblockDms({ account, userId: "12", context });

  assert.deepEqual(
    seen.map((entry) => `${entry.method} ${entry.href}`),
    ["POST https://api.x.com/2/users/12/dm/block", "POST https://api.x.com/2/users/12/dm/unblock"],
  );

  const unconfirmed = fake({ "POST /2/users/12/dm/block": () => Response.json({ data: {} }) });
  await assert.rejects(unconfirmed.native.blockDms({ account, userId: "12", context }), {
    code: "ambiguous_outcome",
  });
});

it("downloads DM media bytes from /dm_conversations/media within maxBytes [feature:x.dm.media_download]", async () => {
  const requests: string[] = [];

  const adapter = x({
    auth: { userId: "11", accessToken: "user" },
    fetch: async (input, init) => {
      requests.push(String(input));
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer user");

      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "image/jpeg" },
      });
    },
  });

  assert.ok(adapter.native);

  const media = await adapter.native.downloadDmMedia({
    account,
    dmId: "1580000000000000000",
    mediaId: "1580000000000000001",
    resourceId: "AbC-d_9",
    context,
  });

  assert.deepEqual(media, { bytes: new Uint8Array([1, 2, 3, 4]), contentType: "image/jpeg" });
  assert.deepEqual(requests, [
    "https://api.x.com/2/dm_conversations/media/1580000000000000000/1580000000000000001/AbC-d_9",
  ]);

  await assert.rejects(
    adapter.native.downloadDmMedia({
      account,
      dmId: "1",
      mediaId: "2",
      resourceId: "3",
      maxBytes: 3,
      context,
    }),
    { code: "media_error" },
  );
  await assert.rejects(
    adapter.native.downloadDmMedia({
      account,
      dmId: "../x",
      mediaId: "2",
      resourceId: "3",
      context,
    }),
    { code: "invalid_input" },
  );

  const missing = x({
    auth: { userId: "11", accessToken: "user" },
    fetch: async () => new Response(null, { status: 404 }),
  });

  assert.ok(missing.native);
  await assert.rejects(
    missing.native.downloadDmMedia({ account, dmId: "1", mediaId: "2", resourceId: "3", context }),
    { code: "not_found", upstreamStatus: 404 },
  );
});

it("maps problems/dm- refusal types to typed upstream codes without the detail [feature:x.dm.refusal_errors]", async () => {
  const refusal = (type: string) =>
    fake({
      "POST /2/dm_conversations/with/12/messages": () =>
        Response.json(
          { type, title: "Forbidden", detail: "Private reason about the recipient", status: 403 },
          { status: 403, headers: { "content-type": "application/problem+json" } },
        ),
    }).native;

  const cases = [
    ["https://api.x.com/2/problems/dm-recipient-not-accepting", "missing_permission"],
    ["https://api.x.com/2/problems/dm-text-too-long", "invalid_input"],
    ["https://api.x.com/2/problems/dm-recipient-not-found", "not_found"],
    ["https://api.x.com/2/problems/dm-rate-limited", "rate_limited"],
  ] as const;

  for (const [type, code] of cases) {
    let error: unknown;

    try {
      await refusal(type).sendDirectMessage({
        account,
        participantId: "12",
        text: "hello",
        context,
      });
    } catch (caught) {
      error = caught;
    }

    assert.ok(error instanceof SocialError);
    assert.equal(error.code, code);
    assert.equal(error.upstreamCode, type.slice("https://api.x.com/2/problems/".length));
    assert.equal(error.upstreamStatus, 403);
    assert.deepEqual(error.retryDisposition, { kind: "never" });
    assert.doesNotMatch(error.message, /Private reason/);
  }

  await assert.rejects(
    refusal("about:blank").sendDirectMessage({
      account,
      participantId: "12",
      text: "hello",
      context,
    }),
    { code: "missing_permission", upstreamCode: undefined },
  );

  const lost = x({
    auth: { userId: "11", accessToken: "user" },
    fetch: async () => {
      throw new TypeError("connection reset");
    },
  });

  assert.ok(lost.native);
  await assert.rejects(
    lost.native.sendConversationMessage({ account, conversationId: "11-12", text: "hi", context }),
    { code: "ambiguous_outcome" },
  );
});
