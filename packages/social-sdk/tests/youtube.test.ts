/* oxlint-disable anti-slop/require-readable-spacing -- provider fixture setup stays grouped by scenario. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { youtube } from "../src/platforms/youtube.js";
import {
  beginYouTubeUpload,
  queryYouTubeUpload,
  sendYouTubeUpload,
} from "../src/platforms/youtube-upload.js";
import { SocialError } from "../src/core/errors.js";

const account = connectedAccountRef({
  backend: "default",
  platform: "youtube",
  accountId: "channel1",
});

it("YouTube preserves empty permission and server failures without replay", async () => {
  for (const status of [403, 503]) {
    let calls = 0;
    await assert.rejects(
      beginYouTubeUpload(
        { channelId: "channel1", size: 100, mimeType: "video/mp4", metadata: {} },
        {
          accessToken: "test",
          fetch: async () => {
            calls++;

            return new Response(null, { status, headers: { "content-length": "0" } });
          },
        },
      ),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
      (error: unknown) =>
        error instanceof SocialError &&
        error.upstreamStatus === status &&
        error.code === (status === 503 ? "ambiguous_outcome" : "media_error"),
    );
    assert.equal(calls, 1);
  }
});

it("YouTube returns an empty Analytics report when the period has no rows", async () => {
  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async () => Response.json({ columnHeaders: [{ name: "views", columnType: "METRIC" }] }),
  });
  const report = await adapter.analytics!.getReport!(
    account,
    { from: "2026-01-01", to: "2026-01-02", metrics: ["views"] },
    {
      backendInstance: "default",
      correlationId: "empty-report",
      retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
    },
  );
  assert.deepEqual(report.rows, []);
});

it("YouTube native resources use Data API routes and preserve page tokens", async () => {
  const calls: URL[] = [];
  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      return Response.json({ items: [], nextPageToken: "next" });
    },
  });
  const context = {
    backendInstance: "default",
    correlationId: "native",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
  };
  await adapter.native!.playlists({ action: "list", mine: true, pageToken: "p1", context });
  await adapter.native!.playlistItems({
    action: "list",
    playlistId: "PL1",
    pageToken: "p2",
    context,
  });
  await adapter.native!.search({
    q: "sdk",
    type: "video",
    order: "date",
    pageToken: "p3",
    context,
  });
  assert.equal(calls[0]?.pathname, "/youtube/v3/playlists");
  assert.equal(calls[0]?.searchParams.get("mine"), "true");
  assert.equal(calls[1]?.searchParams.get("pageToken"), "p2");
  assert.equal(calls[2]?.pathname, "/youtube/v3/search");
});

it("YouTube normalized search rejects unsupported scope and oversized limits", async () => {
  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async () => Response.json({ items: [] }),
  });
  const context = {
    backendInstance: "default",
    correlationId: "search-validation",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
  };
  await assert.rejects(
    () => adapter.search!.posts(account, { query: "x", scope: "all" }, context),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- node:test predicate receives unknown.
    (error: unknown) => error instanceof SocialError && error.code === "invalid_input",
  );
  await assert.rejects(
    () => adapter.search!.posts(account, { query: "x", limit: 51 }, context),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- node:test predicate receives unknown.
    (error: unknown) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("YouTube native deletes accept 204 responses and send only the resource ID", async () => {
  const methods: string[] = [];
  const queries: string[] = [];
  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (input, init) => {
      methods.push(init?.method ?? "GET");
      queries.push(new URL(String(input)).search);
      return new Response(null, { status: 204 });
    },
  });
  const context = {
    backendInstance: "default",
    correlationId: "deletes",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
  };
  await adapter.native!.captions({ action: "delete", videoId: "v", captionId: "c", context });
  await adapter.native!.playlists({ action: "delete", playlistId: "p", context });
  await adapter.native!.playlistItems({ action: "delete", playlistItemId: "i", context });
  await adapter.native!.subscriptions({ action: "delete", subscriptionId: "s", context });
  await adapter.native!.commentsModeration({ action: "delete", commentId: "c", context });
  assert.deepEqual(methods, ["DELETE", "DELETE", "DELETE", "DELETE", "DELETE"]);
  assert.deepEqual(queries, ["?id=c", "?id=p", "?id=i", "?id=s", "?id=c"]);
  await assert.rejects(adapter.native!.playlistItems({ action: "delete", context }), {
    code: "invalid_input",
  });
  assert.equal(methods.length, 5);
});

it("YouTube comment updates send the selected comment ID", async () => {
  const bodies: unknown[] = [];
  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "c1" });
    },
  });
  const context = {
    backendInstance: "default",
    correlationId: "comment-update",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
  };
  await adapter.native!.commentsModeration({
    action: "update",
    commentId: "c1",
    body: { snippet: { textOriginal: "edited" } },
    context,
  });
  assert.deepEqual(bodies, [{ snippet: { textOriginal: "edited" }, id: "c1" }]);
  await assert.rejects(
    adapter.native!.commentsModeration({
      action: "update",
      commentId: "c1",
      body: { id: "c2" },
      context,
    }),
    { code: "invalid_input" },
  );
});

it("YouTube captions use resource download route and related multipart metadata", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return input.toString().includes("/captions/c1")
        ? new Response("WEBVTT", { status: 200 })
        : Response.json({ id: "c1" });
    },
  });
  const context = {
    backendInstance: "default",
    correlationId: "captions",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
  };
  await adapter.native!.captions({ action: "download", videoId: "v", captionId: "c1", context });
  await adapter.native!.captions({
    action: "insert",
    videoId: "v",
    caption: {
      kind: "image",
      filename: "a.vtt",
      mimeType: "text/vtt",
      source: { kind: "blob", blob: new Blob(["WEBVTT"]), fingerprint: "x" },
    },
    body: { snippet: { language: "en", name: "English" } },
    context,
  });
  assert.equal(calls[0]?.url.pathname, "/youtube/v3/captions/c1");
  assert.match(await new Response(calls[1]?.init?.body).text(), /"videoId":"v"/);
  assert.match(
    String(calls[1]?.init?.headers && new Headers(calls[1].init.headers).get("Content-Type")),
    /multipart\/related/,
  );
});

it("YouTube thumbnails use the upload endpoint", async () => {
  let seen: URL | undefined;
  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (input) => {
      seen = new URL(String(input));
      return Response.json({ kind: "youtube#thumbnail" });
    },
  });
  await adapter.native!.setThumbnail({
    videoId: "v1",
    thumbnail: {
      kind: "image",
      mimeType: "image/jpeg",
      source: { kind: "blob", blob: new Blob(["x"]), fingerprint: "x" },
    },
    context: {
      backendInstance: "default",
      correlationId: "thumbnail",
      retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
    },
  });
  assert.equal(seen?.pathname, "/upload/youtube/v3/thumbnails/set");
  assert.equal(seen?.searchParams.get("videoId"), "v1");
});

it("YouTube refuses short and overlong sources before final upload dispatch", async () => {
  for (const actualSize of [99, 101]) {
    let calls = 0;
    await assert.rejects(
      sendYouTubeUpload(
        {
          url: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=secret",
          channelId: "channel1",
          size: 100,
          mimeType: "video/mp4",
        },
        {
          kind: "video",
          source: {
            kind: "blob",
            blob: new Blob([new Uint8Array(actualSize)]),
            fingerprint: "test",
          },
        },
        {
          accessToken: "test",
          fetch: async () => {
            calls++;

            return Response.json({ id: "unexpected" });
          },
        },
      ),
      /declared byte size/,
    );
    assert.equal(calls, 0);
  }
});

it("YouTube creates a resumable session, preserves explicit metadata, streams video and reports processing", async () => {
  const calls: string[] = [];
  let saved = false;

  const social = createSocial({
    backend: youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      saveUploadSession: async (session) => {
        assert.equal(session.channelId, "channel1");
        saved = true;
      },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        calls.push(init?.method ?? "GET");
        assert.equal(url.hostname, "www.googleapis.com");
        assert.equal(init?.redirect, "error");

        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          assert.deepEqual(body.status, {
            privacyStatus: "private",
            selfDeclaredMadeForKids: false,
          });
          assert.equal(body.snippet.title, "Example");

          return new Response(null, {
            headers: {
              location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=secret",
            },
          });
        }

        assert.ok(saved);
        assert.equal(new Headers(init?.headers).get("Content-Range"), "bytes 0-99/100");
        assert.equal(init?.body instanceof Uint8Array && init.body.byteLength, 100);

        return Response.json({
          id: "video1",
          status: { uploadStatus: "uploaded", privacyStatus: "private" },
        });
      },
    }),
  });

  const request = {
    targets: [
      {
        account,
        options: { title: "Example", visibility: "private" as const, madeForKids: false },
      },
    ],
    content: {
      text: "description",
      media: [
        {
          kind: "video" as const,
          mimeType: "video/mp4",
          source: {
            kind: "blob" as const,
            blob: new Blob([new Uint8Array(100)]),
            fingerprint: "v1",
          },
        },
      ],
    },
  };

  assert.ok(social.posts.prepare(request).ok);
  assert.equal(calls.length, 0);
  const result = await social.posts.publish(request);
  assert.equal(result.outcomes[0]?.state, "processing");
  assert.ok(!JSON.stringify(result).includes("upload_id"));
  assert.deepEqual(calls, ["POST", "PUT"]);
});

it("YouTube validates video, visibility and audience locally and rejects wrong-channel refs", () => {
  const social = createSocial({
    backend: youtube({ auth: { accessToken: "test", channelId: "channel1" } }),
  });

  assert.equal(
    social.posts.prepare({ targets: [{ account }], content: { text: "text only" } }).ok,
    false,
  );
  assert.equal(
    social.posts.prepare({
      targets: [{ account: { ...account, accountId: "victim-channel" } }],
      content: { text: "text" },
    }).ok,
    false,
  );
});

it("YouTube validates that a comment belongs to the declared video before replying", async () => {
  const methods: string[] = [];

  const social = createSocial({
    backend: youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      fetch: async (_input, init) => {
        methods.push(init?.method ?? "GET");

        return Response.json({
          items: [{ id: "comment1", snippet: { videoId: "different-video" } }],
        });
      },
    }),
  });

  await assert.rejects(
    social.comments.reply(
      {
        kind: "comment",
        version: 1,
        backend: "default",
        platform: "youtube",
        accountId: "channel1",
        postId: "video1",
        commentId: "comment1",
      },
      { text: "reply" },
    ),
    /does not belong/,
  );
  assert.deepEqual(methods, ["GET"]);
});

it("YouTube resumes only from a caller-confirmed offset and retains 308 progress", async () => {
  const session = {
    url: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=secret",
    channelId: "channel1",
    size: 100,
    mimeType: "video/mp4",
  };

  const options = {
    accessToken: "test",
    fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("Content-Range");

      if (range === "bytes */100")
        return new Response(null, { status: 308, headers: { range: "bytes=0-49" } });
      assert.equal(range, "bytes 50-99/100");
      assert.ok(init?.body instanceof Uint8Array);
      assert.equal(init.body[0], 50);

      return Response.json({ id: "v1", status: { uploadStatus: "processed" } });
    },
  };

  const status = await queryYouTubeUpload(session, options);
  assert.deepEqual(status, { state: "incomplete", nextByte: 50 });

  const result = await sendYouTubeUpload(
    session,
    {
      kind: "video",
      source: {
        kind: "blob",
        blob: new Blob([Uint8Array.from({ length: 100 }, (_, index) => index)]),
        fingerprint: "test",
      },
    },
    options,
    50,
  );

  assert.equal(result.state, "complete");
});

it("YouTube refuses untrusted upload session hosts before forwarding authorization", async () => {
  let calls = 0;
  await assert.rejects(
    queryYouTubeUpload(
      {
        url: "https://attacker.example.test/upload",
        channelId: "channel1",
        size: 100,
        mimeType: "video/mp4",
      },
      {
        accessToken: "private",
        fetch: async () => {
          calls++;

          return new Response();
        },
      },
    ),
  );
  assert.equal(calls, 0);
});
