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
