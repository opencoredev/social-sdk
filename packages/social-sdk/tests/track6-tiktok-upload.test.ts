import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { SocialError } from "../src/core/errors.js";
import { tiktok } from "../src/platforms/tiktok.js";
import type {
  AdapterOperationContext,
  DeliveryOutcome,
  JsonValue,
  MediaAttachment,
  PreparedPublishTarget,
  TikTokPublishOptions,
} from "../src/core/types.js";

const MiB = 1024 * 1024;

const accessToken = "api-secret-token";

const uploadUrl = "https://open-upload.tiktokapis.com/video/?upload_id=u1&upload_token=up-secret";

const account = connectedAccountRef({
  backend: "default",
  platform: "tiktok",
  accountId: "creator1",
});

const creator = {
  accountId: "creator1",
  backend: "default",
  username: "demo",
  nickname: "Demo",
  fetchedAt: "2026-10-24T00:00:00Z",
  privacyLevels: ["SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxVideoDurationSeconds: 60,
};

const options: TikTokPublishOptions = {
  privacy: "SELF_ONLY",
  consentGiven: true,
  disableComments: true,
  disableDuet: true,
  disableStitch: true,
  brandedContent: false,
  ownBrand: false,
  aiGenerated: false,
  draft: false,
};

const baseContext: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
};

// Each call gets a fresh context, so each operation gets its own elapsed budget.
const context = (signal?: AbortSignal): AdapterOperationContext =>
  signal === undefined ? { ...baseContext } : { ...baseContext, signal };

const videoPostInfo = {
  title: "caption",
  privacy_level: "SELF_ONLY",
  disable_comment: true,
  brand_content_toggle: false,
  brand_organic_toggle: false,
  disable_duet: true,
  disable_stitch: true,
  is_aigc: false,
};

const ok = (data: JsonValue) => Response.json({ data, error: { code: "ok" } });

interface Put {
  readonly url: string;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
}

interface Recorder {
  readonly paths: string[];
  readonly initBodies: unknown[];
  readonly puts: Put[];
}

/** Fake TikTok: creator info, FILE_UPLOAD init returning `upload`, and recorded chunk PUTs. */
function fakeTikTok(input: {
  readonly upload?: JsonValue;
  readonly onPut?: (put: Put, index: number) => Response | Promise<Response>;
}) {
  const recorder: Recorder = { paths: [], initBodies: [], puts: [] };

  const fetch: typeof globalThis.fetch = async (request, init) => {
    const url = new URL(String(request));
    recorder.paths.push(url.host + url.pathname);

    if (url.host === "open.tiktokapis.com") {
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${accessToken}`);

      if (url.pathname.endsWith("/creator_info/query/"))
        return ok({
          creator_username: "demo",
          creator_nickname: "Demo",
          privacy_level_options: ["SELF_ONLY"],
          max_video_post_duration_sec: 60,
        });

      recorder.initBodies.push(JSON.parse(String(init?.body)));

      return ok({ publish_id: "pub1", upload_url: input.upload ?? uploadUrl });
    }

    assert.equal(init?.method, "PUT");
    assert.equal(init?.redirect, "manual");
    const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
    const put = { url: String(request), headers: new Headers(init?.headers), bytes };
    recorder.puts.push(put);

    return input.onPut
      ? input.onPut(put, recorder.puts.length - 1)
      : new Response(null, { status: 201 });
  };

  return { recorder, fetch };
}

function patterned(size: number, offset = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);

  for (let index = 0; index < size; index++) bytes[index] = (offset + index) % 251;

  return bytes;
}

/** A pull-based stream of `size` bytes in `piece`-byte reads, recording how far it was read. */
function sizedStream(size: number, piece: number, pulled: { bytes: number } = { bytes: 0 }) {
  return () => {
    let sent = 0;

    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= size) {
          controller.close();

          return;
        }

        const length = Math.min(piece, size - sent);
        controller.enqueue(patterned(length, sent));
        sent += length;
        pulled.bytes = sent;
      },
    });
  };
}

function video(source: MediaAttachment["source"], extra: Partial<MediaAttachment> = {}) {
  return {
    kind: "video" as const,
    mimeType: "video/mp4",
    durationSeconds: 30,
    source,
    ...extra,
  };
}

function target(media: readonly MediaAttachment[]): PreparedPublishTarget {
  return {
    targetIndex: 0,
    targetKey: "t0",
    account,
    content: { text: "caption", media },
    options: { ...options, creatorInfo: creator },
  };
}

function assertNoSecrets(outcome: DeliveryOutcome) {
  const text = JSON.stringify(outcome);
  assert.equal(text.includes(accessToken), false);
  assert.equal(text.includes("up-secret"), false);
  assert.equal(text.includes("upload_token"), false);
}

it("TikTok uploads a small Blob as one FILE_UPLOAD chunk after the creator preflight", async () => {
  const { recorder, fetch } = fakeTikTok({});

  const adapter = tiktok({
    auth: { accessToken, openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch,
  });

  const bytes = patterned(1000);

  const result = await createSocial({ backend: adapter }).posts.publish({
    targets: [{ account, options: { ...options, creatorInfo: creator } }],
    content: {
      text: "caption",
      media: [video({ kind: "blob", blob: new Blob([bytes]), fingerprint: "sha256:small" })],
    },
  });

  const outcome = result.outcomes[0];
  assert.equal(outcome?.state, "processing");
  assert.equal(outcome?.delivery?.deliveryId, "pub1");
  assert.deepEqual(recorder.paths, [
    "open.tiktokapis.com/v2/post/publish/creator_info/query/",
    "open.tiktokapis.com/v2/post/publish/video/init/",
    "open-upload.tiktokapis.com/video/",
  ]);
  assert.deepEqual(recorder.initBodies[0], {
    post_info: videoPostInfo,
    source_info: {
      source: "FILE_UPLOAD",
      video_size: 1000,
      chunk_size: 1000,
      total_chunk_count: 1,
    },
  });

  const [put] = recorder.puts;
  assert.ok(put);
  assert.equal(put.url, uploadUrl);
  assert.equal(put.headers.get("authorization"), null);
  assert.equal(put.headers.get("content-type"), "video/mp4");
  assert.equal(put.headers.get("content-length"), "1000");
  assert.equal(put.headers.get("content-range"), "bytes 0-999/1000");
  assert.deepEqual(put.bytes, bytes);

  if (outcome) assertNoSecrets(outcome);
});

it("TikTok streams a sized video in bounded chunks with exact Content-Range headers", async () => {
  const size = 12 * MiB + 3;
  const pulled = { bytes: 0 };
  const pulledAtPut: number[] = [];

  const { recorder, fetch } = fakeTikTok({
    onPut: (_put, index) => {
      pulledAtPut.push(pulled.bytes);

      return new Response(null, { status: index === 0 ? 206 : 201 });
    },
  });

  const adapter = tiktok({
    auth: { accessToken, openId: "creator1" },
    verifiedMediaOrigins: [],
    uploadChunkBytes: 5 * MiB,
    fetch,
  });

  assert.ok(adapter.posts?.publishTarget);

  const outcome = await adapter.posts.publishTarget(
    target([
      video(
        { kind: "stream", open: sizedStream(size, 700 * 1024, pulled), fingerprint: "sha256:big" },
        { byteSize: size },
      ),
    ]),
    context(),
  );

  assert.equal(outcome.state, "processing");
  assert.equal(outcome.delivery?.deliveryId, "pub1");
  assert.deepEqual(recorder.initBodies[0], {
    post_info: videoPostInfo,
    source_info: {
      source: "FILE_UPLOAD",
      video_size: size,
      chunk_size: 5 * MiB,
      total_chunk_count: 2,
    },
  });
  assert.deepEqual(
    recorder.puts.map((put) => [
      put.headers.get("content-range"),
      put.headers.get("content-length"),
      put.bytes.byteLength,
    ]),
    [
      [`bytes 0-${5 * MiB - 1}/${size}`, String(5 * MiB), 5 * MiB],
      [`bytes ${5 * MiB}-${size - 1}/${size}`, String(size - 5 * MiB), size - 5 * MiB],
    ],
  );
  assert.deepEqual(recorder.puts[1]?.bytes.subarray(0, 4), patterned(4, 5 * MiB));
  // The first chunk was sent while most of the 12 MiB source was still unread.
  assert.ok((pulledAtPut[0] ?? Infinity) < 7 * MiB);
  assert.ok(recorder.puts.every((put) => put.headers.get("authorization") === null));
});

it("TikTok rejects local video sources with unknown or invalid sizes before any request", () => {
  let calls = 0;

  const adapter = tiktok({
    auth: { accessToken, openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async () => {
      calls++;
      throw new Error("must not run");
    },
  });

  const social = createSocial({ backend: adapter });
  const stream = { kind: "stream" as const, open: sizedStream(10, 10), fingerprint: "sha256:s" };
  const blob = { kind: "blob" as const, blob: new Blob([patterned(10)]), fingerprint: "sha256:b" };

  const cases: readonly [MediaAttachment, string][] = [
    [video(stream), "tiktok.size"],
    [video(stream, { byteSize: 0 }), "tiktok.size"],
    [video(stream, { byteSize: 4 * 1024 * MiB + 1 }), "tiktok.size"],
    [video(blob, { byteSize: 11 }), "tiktok.size"],
    [video(blob, { mimeType: "video/x-msvideo" }), "tiktok.mime"],
    [{ kind: "image", mimeType: "image/jpeg", source: blob }, "tiktok.source"],
  ];

  for (const [media, code] of cases) {
    const preparation = social.posts.prepare({
      targets: [{ account, options: { ...options, creatorInfo: creator } }],
      content: { text: "caption", media: [media] },
    });

    assert.equal(preparation.ok, false);
    assert.ok(
      preparation.issues.some((issue) => issue.code === code),
      `${code}: ${JSON.stringify(preparation.issues)}`,
    );
  }

  const valid = social.posts.prepare({
    targets: [{ account, options: { ...options, creatorInfo: creator } }],
    content: { text: "caption", media: [video(stream, { byteSize: 10 })] },
  });

  assert.equal(valid.ok, true, JSON.stringify(valid.issues));
  assert.equal(calls, 0);
});

it("TikTok refuses unsized local video in publishTarget without calling the provider", async () => {
  let calls = 0;

  const adapter = tiktok({
    auth: { accessToken, openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async () => {
      calls++;
      throw new Error("must not run");
    },
  });

  assert.ok(adapter.posts?.publishTarget);
  await assert.rejects(
    adapter.posts.publishTarget(
      target([video({ kind: "stream", open: sizedStream(10, 10), fingerprint: "sha256:s" })]),
      context(),
    ),
    (error: Error) => error instanceof SocialError && error.code === "invalid_input",
  );
  assert.equal(calls, 0);
});

it("TikTok fails a short stream after init and keeps the publish_id for reconciliation", async () => {
  const { recorder, fetch } = fakeTikTok({ onPut: () => new Response(null, { status: 206 }) });

  const adapter = tiktok({
    auth: { accessToken, openId: "creator1" },
    verifiedMediaOrigins: [],
    uploadChunkBytes: 5 * MiB,
    fetch,
  });

  assert.ok(adapter.posts?.publishTarget);

  const outcome = await adapter.posts.publishTarget(
    target([
      video(
        { kind: "stream", open: sizedStream(8 * MiB, MiB), fingerprint: "sha256:short" },
        { byteSize: 11 * MiB },
      ),
    ]),
    context(),
  );

  assert.equal(outcome.state, "failed");
  assert.equal(outcome.delivery?.deliveryId, "pub1");

  if (outcome.state === "failed") {
    assert.equal(outcome.code, "media_error");
    assert.deepEqual(outcome.retryDisposition, { kind: "reconcile-first" });
  }

  // The first chunk went out; the final one never did.
  assert.equal(recorder.puts.length, 1);
  assertNoSecrets(outcome);
});

it("TikTok refuses a stream longer than declared before sending its final chunk", async () => {
  const { recorder, fetch } = fakeTikTok({});

  const adapter = tiktok({
    auth: { accessToken, openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch,
  });

  assert.ok(adapter.posts?.publishTarget);

  const outcome = await adapter.posts.publishTarget(
    target([
      video(
        { kind: "stream", open: sizedStream(2000, 1500), fingerprint: "sha256:long" },
        { byteSize: 1500 },
      ),
    ]),
    context(),
  );

  assert.equal(outcome.state, "failed");
  assert.equal(outcome.delivery?.deliveryId, "pub1");
  assert.equal(recorder.puts.length, 0);
});

it("TikTok never sends bytes to an upload URL outside its known upload hosts", async () => {
  for (const upload of [
    "https://evil.example/video/?upload_token=up-secret",
    "http://open-upload.tiktokapis.com/video/?upload_token=up-secret",
    "https://open-upload.tiktokapis.com.evil.example/video/?upload_token=up-secret",
    "https://user:pass@open-upload.tiktokapis.com/video/?upload_token=up-secret",
  ]) {
    const { recorder, fetch } = fakeTikTok({ upload });

    const adapter = tiktok({
      auth: { accessToken, openId: "creator1" },
      verifiedMediaOrigins: [],
      fetch,
    });

    assert.ok(adapter.posts?.publishTarget);

    const outcome = await adapter.posts.publishTarget(
      target([video({ kind: "blob", blob: new Blob([patterned(10)]), fingerprint: "sha256:b" })]),
      context(),
    );

    assert.equal(outcome.state, "failed", upload);
    assert.equal(outcome.delivery?.deliveryId, "pub1");
    assert.equal(recorder.puts.length, 0);
    assertNoSecrets(outcome);
  }
});

it("TikTok sends each chunk once: a rejected chunk stops the upload without retry", async () => {
  const { recorder, fetch } = fakeTikTok({ onPut: () => new Response("{}", { status: 503 }) });

  const adapter = tiktok({
    auth: { accessToken, openId: "creator1" },
    verifiedMediaOrigins: [],
    uploadChunkBytes: 5 * MiB,
    fetch,
  });

  assert.ok(adapter.posts?.publishTarget);

  const multi = await adapter.posts.publishTarget(
    target([
      video({ kind: "blob", blob: new Blob([patterned(11 * MiB)]), fingerprint: "sha256:m" }),
    ]),
    context(),
  );

  // A failed non-final chunk means the upload cannot complete.
  assert.equal(multi.state, "failed");
  assert.equal(multi.delivery?.deliveryId, "pub1");
  assert.equal(recorder.puts.length, 1);

  if (multi.state === "failed") assert.equal(multi.message.includes("HTTP 503"), true);
  assertNoSecrets(multi);
});

it("TikTok reports a final chunk 5xx or redirect as uncertain and keeps the publish_id", async () => {
  for (const status of [500, 307]) {
    const { recorder, fetch } = fakeTikTok({
      onPut: () =>
        new Response(null, {
          status,
          headers: status === 307 ? { location: "https://evil.example/" } : {},
        }),
    });

    const adapter = tiktok({
      auth: { accessToken, openId: "creator1" },
      verifiedMediaOrigins: [],
      fetch,
    });

    assert.ok(adapter.posts?.publishTarget);

    const outcome = await adapter.posts.publishTarget(
      target([video({ kind: "blob", blob: new Blob([patterned(10)]), fingerprint: "sha256:b" })]),
      context(),
    );

    assert.equal(outcome.state, "unknown", String(status));
    assert.equal(outcome.delivery?.deliveryId, "pub1");
    assert.equal(recorder.puts.length, 1);
    assert.equal(recorder.paths.filter((path) => path.startsWith("evil")).length, 0);
    assertNoSecrets(outcome);
  }
});

it("TikTok cancellation keeps the publish_id: cancelled mid-upload, uncertain on the final chunk", async () => {
  for (const abortAt of [0, 1]) {
    const controller = new AbortController();

    const { recorder, fetch } = fakeTikTok({
      onPut: (_put, index) => {
        if (index === abortAt) {
          controller.abort(new Error("caller cancelled"));

          return new Promise<Response>(() => undefined);
        }

        return new Response(null, { status: 206 });
      },
    });

    const adapter = tiktok({
      auth: { accessToken, openId: "creator1" },
      verifiedMediaOrigins: [],
      uploadChunkBytes: 5 * MiB,
      fetch,
    });

    assert.ok(adapter.posts?.publishTarget);

    const outcome = await adapter.posts.publishTarget(
      target([
        video({ kind: "blob", blob: new Blob([patterned(11 * MiB)]), fingerprint: "sha256:c" }),
      ]),
      context(controller.signal),
    );

    assert.equal(outcome.state, abortAt === 0 ? "cancelled" : "unknown");
    assert.equal(outcome.delivery?.deliveryId, "pub1");
    assert.equal(recorder.puts.length, abortAt + 1);
  }
});

it("TikTok keeps verified PULL_FROM_URL video publishing unchanged", async () => {
  const { recorder, fetch } = fakeTikTok({});

  const adapter = tiktok({
    auth: { accessToken, openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch,
  });

  const result = await createSocial({ backend: adapter }).posts.publish({
    targets: [{ account, options: { ...options, creatorInfo: creator } }],
    content: {
      text: "caption",
      media: [video({ kind: "https-url", url: "https://media.example.test/video.mp4" })],
    },
  });

  assert.equal(result.outcomes[0]?.state, "accepted");
  assert.equal(result.outcomes[0]?.backendState, "INITIALIZED");
  assert.deepEqual(recorder.initBodies[0], {
    post_info: videoPostInfo,
    source_info: { source: "PULL_FROM_URL", video_url: "https://media.example.test/video.mp4" },
  });
  assert.equal(recorder.puts.length, 0);
});

it("TikTok declares its publish media sources and limits, and validates chunk size config", () => {
  const adapter = tiktok({ auth: { accessToken, openId: "creator1" }, verifiedMediaOrigins: [] });

  const publish = adapter.capabilities.capabilities.find(
    (capability) => capability.operation === "posts.publish",
  );

  assert.deepEqual(publish?.constraints?.mediaSources, ["https-url", "blob", "stream"]);
  assert.equal(publish?.constraints?.maxItems, 1);
  assert.equal(publish?.constraints?.maxBytes, 4 * 1024 * MiB);

  const photos = adapter.capabilities.capabilities.find(
    (capability) =>
      capability.operation === "posts.publish" && capability.formats?.includes("image"),
  );

  assert.deepEqual(photos?.constraints?.mediaSources, ["https-url"]);
  assert.equal(photos?.constraints?.maxItems, 35);

  for (const uploadChunkBytes of [MiB, 65 * MiB, 5 * MiB + 0.5])
    assert.throws(
      () =>
        tiktok({
          auth: { accessToken, openId: "creator1" },
          verifiedMediaOrigins: [],
          uploadChunkBytes,
        }),
      (error: Error) => error instanceof SocialError && error.code === "invalid_config",
    );
});

it("TikTok metrics keep provider names and add canonical names where equivalent", async () => {
  const adapter = tiktok({
    auth: { accessToken, openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async (request) =>
      String(request).includes("/v2/video/query/")
        ? ok({
            videos: [
              { id: "post1", like_count: 4, comment_count: 2, share_count: 1, view_count: 20 },
            ],
          })
        : ok({
            user: {
              open_id: "creator1",
              display_name: "Demo",
              follower_count: 9,
              following_count: 3,
              likes_count: 40,
              video_count: 5,
            },
          }),
  });

  assert.ok(adapter.analytics?.getPostMetrics && adapter.analytics.getAccountMetrics);

  const post = await adapter.analytics.getPostMetrics(
    {
      kind: "platform-post",
      version: 1,
      backend: "default",
      platform: "tiktok",
      accountId: "creator1",
      postId: "post1",
    },
    context(),
  );

  assert.deepEqual(
    post.map((metric) => [metric.name, metric.canonicalName]),
    [
      ["like_count", "likes"],
      ["comment_count", "comments"],
      ["share_count", "shares"],
      ["view_count", "views"],
    ],
  );

  const accountMetrics = await adapter.analytics.getAccountMetrics(account, context());
  const follower = accountMetrics.find((metric) => metric.name === "follower_count");
  assert.equal(follower?.canonicalName, "followers");
  assert.equal(
    accountMetrics.find((metric) => metric.name === "likes_count")?.canonicalName,
    "likes",
  );
});
