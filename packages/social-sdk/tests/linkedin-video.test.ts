import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { linkedin } from "../src/platforms/linkedin.js";
import type { JsonObject, MediaAttachment, MediaRef } from "../src/core/types.js";

/* oxlint-disable anti-slop/require-readable-spacing -- Keep fixture branches compact. */

const nativeContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

const account = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: "urn:li:person:member1",
});

const auth = { accessToken: "secret", author: "urn:li:person:member1" as const };
const part = 4 * 1024 * 1024;
const uploadBase = "https://www.linkedin.com/dms-uploads/sp/v2/D5610AQ/uploadedVideo";

interface Call {
  url: string;
  method: string;
  body?: JsonObject;
  bytes?: number;
  blobBody?: boolean;
  headers: Headers;
}

async function record(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Call> {
  const url = String(input);
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);

  if (url.startsWith(uploadBase)) {
    // Read the whole part before answering, the way a real upload endpoint would.
    const blobBody = init?.body instanceof Blob;
    const bytes = (await new Response(init?.body).arrayBuffer()).byteLength;

    return { url, method, headers, bytes, blobBody };
  }

  // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- fixture contract.
  return { url, method, headers, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
}

function video(size: number, extra: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    kind: "video",
    mimeType: "video/mp4",
    source: { kind: "blob", blob: new Blob([new Uint8Array(size)]), fingerprint: "fixture" },
    byteSize: size,
    ...extra,
  };
}

function initialized(size: number, instructions?: { firstByte: number; lastByte: number }[]) {
  const plan = instructions ?? [
    { firstByte: 0, lastByte: part - 1 },
    { firstByte: part, lastByte: size - 1 },
  ];

  return Response.json({
    value: {
      uploadUrlsExpireAt: 1_790_000_000_000,
      video: "urn:li:video:C5F10AQ",
      uploadInstructions: plan.map((entry, index) => ({
        ...entry,
        uploadUrl: `${uploadBase}?ca=vector_feedshare&part=${index}`,
      })),
      uploadToken: "",
    },
  });
}

const videoRef: MediaRef = {
  kind: "media",
  version: 1,
  backend: "default",
  platform: "linkedin",
  accountId: auth.author,
  mediaId: "urn:li:video:C5F10AQ",
};

function videoPost(extra: Partial<MediaAttachment> = {}) {
  return {
    targets: [{ account }],
    content: {
      text: "Clip",
      media: [
        { kind: "video" as const, source: { kind: "media-ref" as const, ref: videoRef }, ...extra },
      ],
    },
  };
}

it("LinkedIn uploads video parts in order and finalizes with unquoted ETags", async () => {
  const size = part + 100_000;
  const calls: Call[] = [];

  const social = createSocial({
    backend: linkedin({
      auth,
      apiVersion: "202609",
      fetch: async (input, init) => {
        const call = await record(input, init);
        calls.push(call);

        if (call.url.endsWith("action=initializeUpload")) return initialized(size);

        if (call.url.startsWith(uploadBase))
          return new Response(null, {
            status: 200,
            headers: { etag: call.url.endsWith("part=0") ? '"etag-a"' : "etag-b" },
          });

        return new Response(null, { status: 200 });
      },
    }),
  });

  const ref = await social.media.upload(video(size, { durationSeconds: 12 }), account);
  assert.deepEqual(ref, videoRef);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url.split("?")[0]}`),
    [
      "POST https://api.linkedin.com/rest/videos",
      `PUT ${uploadBase}`,
      `PUT ${uploadBase}`,
      "POST https://api.linkedin.com/rest/videos",
    ],
  );
  assert.deepEqual(calls[0]?.body, {
    initializeUploadRequest: {
      owner: auth.author,
      fileSizeBytes: size,
      uploadCaptions: false,
      uploadThumbnail: false,
    },
  });
  assert.equal(calls[1]?.headers.get("content-type"), "application/octet-stream");
  assert.equal(calls[1]?.headers.get("authorization"), null);
  // Each part goes out as a Blob slice, and storage reads it in full before answering.
  assert.equal(calls[1]?.bytes, part);
  assert.equal(calls[2]?.bytes, 100_000);
  assert.equal(calls[1]?.blobBody, true);
  assert.equal(calls[2]?.blobBody, true);
  assert.equal(calls[1]?.headers.get("content-length"), String(part));
  assert.equal(calls[2]?.headers.get("content-length"), "100000");
  assert.ok(calls[3]?.url.endsWith("action=finalizeUpload"));
  assert.deepEqual(calls[3]?.body, {
    finalizeUploadRequest: {
      video: "urn:li:video:C5F10AQ",
      uploadToken: "",
      uploadedPartIds: ["etag-a", "etag-b"],
    },
  });
});

it("LinkedIn sends no video bytes when the upload plan does not cover the file", async () => {
  const size = part + 100_000;

  for (const plan of [
    [{ firstByte: 0, lastByte: part - 1 }],
    [
      { firstByte: 0, lastByte: part - 1 },
      { firstByte: part + 1, lastByte: size - 1 },
    ],
    [{ firstByte: 0, lastByte: size - 1 }],
  ]) {
    const methods: string[] = [];

    const social = createSocial({
      backend: linkedin({
        auth,
        apiVersion: "202609",
        fetch: async (input, init) => {
          methods.push(`${init?.method ?? "GET"} ${String(input).split("?")[0]}`);

          return initialized(size, plan);
        },
      }),
    });

    await assert.rejects(social.media.upload(video(size), account), {
      name: "SocialError",
      code: "media_error",
    });
    assert.deepEqual(methods, ["POST https://api.linkedin.com/rest/videos"]);
  }
});

it("LinkedIn stops before finalize when a video part fails or lacks an ETag", async () => {
  const size = part + 100_000;

  for (const response of [
    () => new Response(null, { status: 401 }),
    () => new Response(null, { status: 500 }),
    () => new Response(null, { status: 200 }),
  ]) {
    const calls: string[] = [];

    const social = createSocial({
      backend: linkedin({
        auth,
        apiVersion: "202609",
        fetch: async (input, init) => {
          const url = String(input);
          calls.push(`${init?.method ?? "GET"} ${url.split("?")[1] ?? ""}`);

          if (url.endsWith("action=initializeUpload")) return initialized(size);
          await record(input, init);

          return response();
        },
      }),
    });

    await assert.rejects(social.media.upload(video(size), account), {
      name: "SocialError",
      code: "media_error",
      retryDisposition: { kind: "never" },
      // Upload URLs are signed, so they must never appear in the error.
      message: /^(?!.*dms-uploads)/,
    });
    assert.deepEqual(calls, ["POST action=initializeUpload", "PUT ca=vector_feedshare&part=0"]);
  }
});

it("LinkedIn validates video input locally before any request", async () => {
  let calls = 0;

  const social = createSocial({
    backend: linkedin({
      auth,
      apiVersion: "202609",
      fetch: async () => {
        calls++;

        return new Response(null, { status: 500 });
      },
    }),
  });

  for (const media of [
    video(100_000, { mimeType: "video/quicktime" }),
    video(1000),
    video(100_000, { byteSize: 99_999 }),
    video(100_000, { durationSeconds: 2 }),
    video(100_000, { durationSeconds: 1801 }),
    {
      kind: "video" as const,
      mimeType: "video/mp4",
      source: {
        kind: "stream" as const,
        open: () => new Blob([new Uint8Array(100_000)]).stream(),
        fingerprint: "fixture",
      },
    },
  ])
    await assert.rejects(social.media.upload(media, account), {
      name: "SocialError",
      code: "invalid_input",
    });

  assert.equal(calls, 0);
});

it("LinkedIn publishes an AVAILABLE video as a single media post without alt text", async () => {
  const calls: Call[] = [];

  const social = createSocial({
    backend: linkedin({
      auth,
      apiVersion: "202609",
      fetch: async (input, init) => {
        const call = await record(input, init);
        calls.push(call);

        if (call.method === "GET")
          return Response.json({ id: videoRef.mediaId, owner: auth.author, status: "AVAILABLE" });

        return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7" } });
      },
    }),
  });

  const result = await social.posts.publish(videoPost());
  assert.equal(result.outcomes[0]?.state, "published");
  assert.equal(
    calls[0]?.url,
    `https://api.linkedin.com/rest/videos/${encodeURIComponent(videoRef.mediaId)}`,
  );
  assert.equal(calls[1]?.url, "https://api.linkedin.com/rest/posts");
  assert.deepEqual(calls[1]?.body?.["content"], { media: { id: videoRef.mediaId } });
});

it("LinkedIn creates no video post while processing, after failure, or for another owner", async () => {
  for (const [status, owner, code] of [
    ["PROCESSING", auth.author, "media_error"],
    ["WAITING_UPLOAD", auth.author, "media_error"],
    ["PROCESSING_FAILED", auth.author, "media_error"],
    ["AVAILABLE", "urn:li:person:other", "unauthorized"],
  ]) {
    const methods: string[] = [];

    const social = createSocial({
      backend: linkedin({
        auth,
        apiVersion: "202609",
        fetch: async (_input, init) => {
          methods.push(init?.method ?? "GET");

          return Response.json({ id: videoRef.mediaId, owner, status });
        },
      }),
    });

    const result = await social.posts.publish(videoPost());
    const outcome = result.outcomes[0];
    assert.equal(outcome?.state, "failed");
    if (outcome?.state === "failed") assert.equal(outcome.code, code);
    assert.deepEqual(methods, ["GET"]);
  }
});

it("LinkedIn prepare rejects mismatched video URNs and video alt text", () => {
  const social = createSocial({
    backend: linkedin({ auth, apiVersion: "202609", fetch: async () => new Response(null) }),
  });

  const wrongUrn = {
    targets: [{ account }],
    content: {
      media: [
        {
          kind: "video" as const,
          source: {
            kind: "media-ref" as const,
            ref: { ...videoRef, mediaId: "urn:li:image:img1" },
          },
        },
      ],
    },
  };

  const codes = (request: Parameters<typeof social.posts.prepare>[0]) =>
    social.posts.prepare(request).issues.map((issue) => issue.code);

  assert.ok(codes(wrongUrn).includes("linkedin.media_owner"));
  assert.ok(codes(videoPost({ altText: "A clip" })).includes("linkedin.video_alt_text"));
  assert.equal(social.posts.prepare(videoPost()).ok, true);

  const imageRef: MediaRef = { ...videoRef, mediaId: "urn:li:image:img1" };
  const mixed = {
    targets: [{ account }],
    content: {
      media: [
        { kind: "video" as const, source: { kind: "media-ref" as const, ref: videoRef } },
        { kind: "image" as const, source: { kind: "media-ref" as const, ref: imageRef } },
      ],
    },
  };
  assert.ok(codes(mixed).includes("linkedin.media_count"));
});

it("LinkedIn videoStatus reads one status and rejects other owners", async () => {
  const urls: string[] = [];
  let owner: string = auth.author;

  const adapter = linkedin({
    auth,
    apiVersion: "202609",
    fetch: async (input) => {
      urls.push(String(input));

      return Response.json({
        id: videoRef.mediaId,
        owner,
        status: "PROCESSING",
        duration: 12,
        uploadUrl: "https://www.linkedin.com/dms-uploads/private",
      });
    },
  });

  const status = await adapter.native!.videoStatus(videoRef, nativeContext);
  assert.deepEqual(status, {
    id: videoRef.mediaId,
    owner: auth.author,
    status: "PROCESSING",
    duration: 12,
  });
  assert.deepEqual(urls, [
    `https://api.linkedin.com/rest/videos/${encodeURIComponent(videoRef.mediaId)}`,
  ]);

  owner = "urn:li:person:other";
  await assert.rejects(adapter.native!.videoStatus(videoRef, nativeContext), {
    name: "SocialError",
    code: "unauthorized",
  });
  await assert.rejects(
    adapter.native!.videoStatus({ ...videoRef, mediaId: "urn:li:image:1" }, nativeContext),
    { name: "SocialError", code: "invalid_input" },
  );
  assert.equal(urls.length, 2);
});

it("LinkedIn declares video posts and video media uploads as available", () => {
  const social = createSocial({
    backend: linkedin({ auth, apiVersion: "202609", fetch: async () => new Response(null) }),
  });

  const entries = social
    .capabilities()
    .default.capabilities.filter((entry) =>
      ["posts.video", "media.upload", "posts.publish"].includes(entry.operation),
    );

  for (const entry of entries) {
    assert.equal(entry.availability, "available");
    assert.ok(entry.formats?.includes("video"));
  }
  assert.equal(entries.length, 3);
});
