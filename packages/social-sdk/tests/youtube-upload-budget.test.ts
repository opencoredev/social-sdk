import { strict as assert } from "node:assert";
import { it } from "node:test";
import {
  beginYouTubeUpload,
  sendYouTubeUpload,
  type YouTubeUploadSession,
} from "../src/platforms/youtube-upload.js";

it("bounds an uncooperative fetch without waiting for abort", async () => {
  const started = Date.now();
  await assert.rejects(
    () =>
      beginYouTubeUpload(
        { channelId: "c", size: 1, mimeType: "video/mp4", metadata: {} },
        {
          accessToken: "token",
          timeoutMs: 10,
          fetch: () => new Promise<Response>(() => undefined),
        },
      ),
    (error: { code?: string }) => error.code === "timeout" || error.code === "ambiguous_outcome",
  );
  assert.ok(Date.now() - started < 500);
});

it("uses one deadline across source reads and upload chunks", async () => {
  const session: YouTubeUploadSession = {
    url: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=session",
    size: 1,
    mimeType: "video/mp4",
    channelId: "c",
  };

  await assert.rejects(
    () =>
      sendYouTubeUpload(
        session,
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        {
          kind: "video",
          source: {
            kind: "stream",
            open: () =>
              new ReadableStream({
                pull() {
                  return new Promise<void>(() => undefined);
                },
              }),
          },
        } as never,
        {
          accessToken: "token",
          timeoutMs: 10,
          fetch: async () => new Response(null, { status: 308 }),
        },
      ),
    (error: { code?: string }) => error.code === "timeout" || error.code === "ambiguous_outcome",
  );
});

it("cancels a hung POST even when fetch ignores AbortSignal", async () => {
  const controller = new AbortController();

  const pending = beginYouTubeUpload(
    { channelId: "c", size: 1, mimeType: "video/mp4", metadata: {} },
    {
      accessToken: "token",
      signal: controller.signal,
      timeoutMs: 1000,
      fetch: () => new Promise<Response>(() => undefined),
    },
  );

  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, (error: { code?: string }) => error.code === "cancelled");
});

it("does not dispatch when the supplied deadline already expired", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      beginYouTubeUpload(
        { channelId: "c", size: 1, mimeType: "video/mp4", metadata: {} },
        {
          accessToken: "token",
          deadlineAt: Date.now() - 1,
          fetch: async () => {
            calls++;

            return new Response(null);
          },
        },
      ),
    (error: { code?: string }) => error.code === "timeout",
  );
  assert.equal(calls, 0);
});

it("shares timeout budget across multiple chunks", async () => {
  const session: YouTubeUploadSession = {
    url: "https://www.googleapis.com/upload/youtube/v3/videos",
    size: 16 * 1024 * 1024,
    mimeType: "video/mp4",
    channelId: "c",
  };

  const bytes = new Uint8Array(session.size);
  let calls = 0;
  await assert.rejects(
    () =>
      sendYouTubeUpload(
        session,
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
        {
          kind: "video",
          source: {
            kind: "stream",
            open: () =>
              new ReadableStream({
                start(controller) {
                  controller.enqueue(bytes.subarray(0, 8 * 1024 * 1024));
                  controller.enqueue(bytes.subarray(8 * 1024 * 1024));
                  controller.close();
                },
              }),
          },
        } as never,
        {
          accessToken: "token",
          // Generous enough that the first chunk always dispatches on a slow
          // runner, and exhausted long before the response, so a second chunk
          // can never be sent.
          timeoutMs: 500,
          fetch: async () => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 700));

            const uploaded = lengths.reduce((total, length) => total + length, 0);

            return new Response(null, {
              status: 308,
              headers: { range: `bytes=0-${uploaded - 1}` },
            });
          },
        },
      ),
    (error: { code?: string }) => error.code === "timeout" || error.code === "ambiguous_outcome",
  );
  assert.equal(calls, 1);
});

it("splits a single oversized stream chunk into resumable requests", async () => {
  const size = 20 * 1024 * 1024;

  const session: YouTubeUploadSession = {
    url: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=session",
    size,
    mimeType: "video/mp4",
    channelId: "c",
  };

  const bytes = new Uint8Array(size);
  const lengths: number[] = [];

  // SAFETY: the uploader only reads `kind` and `source` from the media descriptor.
  const result = await sendYouTubeUpload(
    session,
    {
      kind: "video",
      source: {
        kind: "stream",
        open: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
      },
    } as never,
    {
      accessToken: "token",
      fetch: async (_url, init) => {
        lengths.push(Number(new Headers(init?.headers).get("Content-Length")));
        const uploaded = lengths.reduce((total, length) => total + length, 0);

        return new Response(null, { status: 308, headers: { range: `bytes=0-${uploaded - 1}` } });
      },
    },
  );

  assert.deepEqual(lengths, [8 * 1024 * 1024, 8 * 1024 * 1024, 4 * 1024 * 1024]);
  assert.deepEqual(result, { state: "incomplete", nextByte: size });
});

it("maps Google's nested quotaExceeded reason to rate_limited", async () => {
  await assert.rejects(
    () =>
      beginYouTubeUpload(
        { channelId: "c", size: 1, mimeType: "video/mp4", metadata: {} },
        {
          accessToken: "token",
          fetch: async () =>
            Response.json(
              { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } },
              { status: 403 },
            ),
        },
      ),
    (error: { code?: string }) => error.code === "rate_limited",
  );
});
