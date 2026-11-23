import { it } from "node:test";
import assert from "node:assert/strict";
import { SocialError } from "../src/core/errors.js";
import {
  queryYouTubeUpload,
  type YouTubeUploadOptions,
  type YouTubeUploadSession,
} from "../src/platforms/youtube-upload.js";

const session: YouTubeUploadSession = {
  url: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=session",
  size: 100,
  mimeType: "video/mp4",
  channelId: "c",
};

const incomplete = async () => new Response(null, { status: 308, headers: { range: "bytes=0-9" } });

it("a reused options object gets a fresh deadline on every call", async () => {
  let calls = 0;
  let nowMs = 1_000;

  const options: YouTubeUploadOptions = {
    accessToken: "token",
    timeoutMs: 50,
    now: () => nowMs,
    fetch: async () => {
      calls++;

      return incomplete();
    },
  };

  assert.deepEqual(await queryYouTubeUpload(session, options), {
    state: "incomplete",
    nextByte: 10,
  });

  // Advance past timeoutMs: a deadline cached from the first call would already be expired.
  nowMs += 80;

  assert.deepEqual(await queryYouTubeUpload(session, options), {
    state: "incomplete",
    nextByte: 10,
  });
  assert.equal(calls, 2);
});

it("measures the deadline with the injected clock", async () => {
  let clock = 1_000_000;
  let calls = 0;

  const options: YouTubeUploadOptions = {
    accessToken: "token",
    timeoutMs: 5_000,
    // Each reading advances ten seconds, so the deadline fixed at entry has passed by the
    // pre-dispatch check.
    now: () => (clock += 10_000),
    fetch: async () => {
      calls++;

      return incomplete();
    },
  };

  await assert.rejects(
    queryYouTubeUpload(session, options),
    (error) => error instanceof SocialError && error.code === "timeout",
  );
  assert.equal(calls, 0);
});

it("an explicit deadlineAt is shared and never extended", async () => {
  let calls = 0;

  const options: YouTubeUploadOptions = {
    accessToken: "token",
    deadlineAt: 2_000,
    now: () => 1_000,
    fetch: async () => {
      calls++;

      return incomplete();
    },
  };

  await queryYouTubeUpload(session, options);
  await assert.rejects(
    queryYouTubeUpload(session, { ...options, now: () => 2_000 }),
    (error) => error instanceof SocialError && error.code === "timeout",
  );
  assert.equal(calls, 1);
});

it("a timeout beyond the 32-bit timer limit does not abort the request early", async () => {
  let aborted = false;

  const options: YouTubeUploadOptions = {
    accessToken: "token",
    timeoutMs: 30 * 24 * 60 * 60_000,
    fetch: async (_input, init) => {
      // An oversized timer would fire after 1 ms and abort this request.
      await new Promise((resolve) => setTimeout(resolve, 20));
      aborted = init?.signal?.aborted === true;

      return incomplete();
    },
  };

  assert.deepEqual(await queryYouTubeUpload(session, options), {
    state: "incomplete",
    nextByte: 10,
  });
  assert.equal(aborted, false);
});
