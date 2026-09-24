/* oxlint-disable anti-slop/require-readable-spacing -- compact mocked transport fixtures. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });
const auth = { userId: "u1", accessToken: "test" };
const xChunkSize = 1024 * 1024;

function videoBlob(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "video/mp4" });
}

function gifBlob(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "image/gif" });
}

it("X video publish uses 1 MiB chunked upload and attaches the finalized media", async () => {
  const paths: string[] = [];
  const segments: string[] = [];
  const size = 2 * 1024 * 1024 + 512 * 1024;

  const social = createSocial({
    backend: x({
      auth,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        paths.push(url.pathname);

        if (url.pathname === "/2/media/upload/initialize") {
          const body = JSON.parse(String(init?.body));
          assert.equal(body.media_category, "tweet_video");
          assert.equal(body.total_bytes, size);

          return Response.json({ data: { id: "video1" } });
        }

        if (url.pathname.endsWith("/append")) {
          assert.ok(init?.body instanceof FormData);
          segments.push(String(init.body.get("segment_index")));

          return new Response(null, { status: 204 });
        }

        if (url.pathname.endsWith("/finalize")) return Response.json({ data: { id: "video1" } });

        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.media, { media_ids: ["video1"] });

        return Response.json({ data: { id: "post1" } });
      },
    }),
  });

  const result = await social.posts.publish({
    targets: [{ account }],
    content: {
      text: "Video",
      media: [
        {
          kind: "video",
          mimeType: "video/mp4",
          filename: "clip.mp4",
          byteSize: size,
          source: { kind: "blob", blob: videoBlob(size), fingerprint: "video1" },
        },
      ],
    },
  });

  assert.equal(result.outcomes[0]?.state, "published");
  assert.deepEqual(segments, ["0", "1", "2"]);
  assert.deepEqual(paths, [
    "/2/media/upload/initialize",
    "/2/media/upload/video1/append",
    "/2/media/upload/video1/append",
    "/2/media/upload/video1/append",
    "/2/media/upload/video1/finalize",
    "/2/tweets",
  ]);
});

it("X GIF upload polls processing_info until succeeded", async () => {
  const paths: string[] = [];
  let statusCalls = 0;

  const social = createSocial({
    backend: x({
      auth,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        paths.push(url.pathname);

        if (url.pathname === "/2/media/upload/initialize") {
          const body = JSON.parse(String(init?.body));
          assert.equal(body.media_category, "tweet_gif");

          return Response.json({ data: { id: "gif1" } });
        }

        if (url.pathname.endsWith("/append")) return new Response(null, { status: 204 });

        if (url.pathname.endsWith("/finalize"))
          return Response.json({
            data: { id: "gif1", processing_info: { state: "pending", check_after_secs: 0 } },
          });

        if (url.pathname === "/2/media/upload") {
          statusCalls++;

          return statusCalls === 1
            ? Response.json({
                data: {
                  id: "gif1",
                  processing_info: { state: "in_progress", check_after_secs: 0 },
                },
              })
            : Response.json({ data: { id: "gif1", processing_info: { state: "succeeded" } } });
        }

        return Response.json({ data: { id: "post2" } });
      },
    }),
  });

  const blob = gifBlob(100);
  const result = await social.posts.publish({
    targets: [{ account }],
    content: {
      text: "GIF",
      media: [
        {
          kind: "image",
          mimeType: "image/gif",
          filename: "clip.gif",
          byteSize: blob.size,
          source: { kind: "blob", blob, fingerprint: "gif1" },
        },
      ],
    },
  });

  assert.equal(result.outcomes[0]?.state, "published");
  assert.equal(statusCalls, 2);
  assert.ok(paths.includes("/2/media/upload"));
});

it("X chunked upload maps a 413 chunk rejection to media_error without retrying the post", async () => {
  let appends = 0;

  const social = createSocial({
    backend: x({
      auth,
      fetch: async (input) => {
        const url = new URL(String(input));

        if (url.pathname === "/2/media/upload/initialize")
          return Response.json({ data: { id: "video2" } });

        if (url.pathname.endsWith("/append")) {
          appends++;

          return new Response("", { status: 413 });
        }

        throw new Error(`unexpected request to ${url.pathname}`);
      },
    }),
  });

  const blob = videoBlob(100);
  const result = await social.posts.publish({
    targets: [{ account }],
    content: {
      text: "Video",
      media: [
        {
          kind: "video",
          mimeType: "video/mp4",
          filename: "clip.mp4",
          byteSize: blob.size,
          source: { kind: "blob", blob, fingerprint: "video2" },
        },
      ],
    },
  });

  assert.equal(result.outcomes[0]?.state, "failed");
  assert.equal(appends, 1);

  if (result.outcomes[0]?.state === "failed") {
    assert.equal(result.outcomes[0].code, "media_error");
    assert.match(result.outcomes[0].message, /chunk rejected/);
  }
});

it("X failed media processing never creates a post", async () => {
  let tweets = 0;

  const social = createSocial({
    backend: x({
      auth,
      fetch: async (input) => {
        const url = new URL(String(input));

        if (url.pathname === "/2/media/upload/initialize")
          return Response.json({ data: { id: "video3" } });

        if (url.pathname.endsWith("/append")) return new Response(null, { status: 204 });

        if (url.pathname.endsWith("/finalize"))
          return Response.json({
            data: { id: "video3", processing_info: { state: "failed" } },
          });

        tweets++;

        return Response.json({ data: { id: "post3" } });
      },
    }),
  });

  const blob = videoBlob(100);
  const result = await social.posts.publish({
    targets: [{ account }],
    content: {
      text: "Video",
      media: [
        {
          kind: "video",
          mimeType: "video/mp4",
          filename: "clip.mp4",
          byteSize: blob.size,
          source: { kind: "blob", blob, fingerprint: "video3" },
        },
      ],
    },
  });

  assert.equal(result.outcomes[0]?.state, "failed");
  assert.equal(tweets, 0);
});

it("X validates chunked media locally without network access", () => {
  let calls = 0;
  const social = createSocial({
    backend: x({
      auth,
      fetch: async () => {
        calls++;

        return Response.json({ data: { id: "never" } });
      },
    }),
  });

  const mixed = social.posts.prepare({
    targets: [{ account }],
    content: {
      text: "Mixed",
      media: [
        {
          kind: "video",
          mimeType: "video/mp4",
          filename: "clip.mp4",
          source: { kind: "blob", blob: videoBlob(10), fingerprint: "mix" },
        },
        {
          kind: "image",
          mimeType: "image/png",
          filename: "still.png",
          source: {
            kind: "blob",
            blob: new Blob([new Uint8Array(10)], { type: "image/png" }),
            fingerprint: "still",
          },
        },
      ],
    },
  });

  assert.equal(mixed.ok, false);
  assert.equal(calls, 0);
});

function chunkedFetch(
  handlers: {
    status?: () => Response;
    finalize?: () => Response;
    tweet?: () => Response;
  },
  seen: { url: URL; init: RequestInit | undefined }[] = [],
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    seen.push({ url, init });

    if (url.pathname === "/2/media/upload/initialize") return Response.json({ data: { id: "m1" } });

    if (url.pathname.endsWith("/append")) return new Response(null, { status: 204 });

    if (url.pathname.endsWith("/finalize"))
      return handlers.finalize?.() ?? Response.json({ data: { id: "m1" } });

    if (url.pathname === "/2/media/upload")
      return handlers.status?.() ?? Response.json({ data: { id: "m1" } });

    return handlers.tweet?.() ?? Response.json({ data: { id: "post" } });
  };
}

function videoContent(blob: Blob) {
  return {
    text: "Video",
    media: [
      {
        kind: "video" as const,
        mimeType: "video/mp4",
        filename: "clip.mp4",
        byteSize: blob.size,
        source: { kind: "blob" as const, blob, fingerprint: "v" },
      },
    ],
  };
}

it("X chunked upload follows the documented v2 wire contract", async () => {
  const seen: { url: URL; init: RequestInit | undefined }[] = [];
  const size = xChunkSize + 7;
  const bytes = new Uint8Array(size).map((_, index) => index % 251);
  const social = createSocial({
    backend: x({
      auth,
      fetch: chunkedFetch(
        {
          finalize: () =>
            Response.json({
              data: { id: "m1", processing_info: { state: "pending", check_after_secs: 0 } },
            }),
          status: () =>
            Response.json({ data: { id: "m1", processing_info: { state: "succeeded" } } }),
        },
        seen,
      ),
    }),
  });

  const result = await social.posts.publish({
    targets: [{ account }],
    content: videoContent(new Blob([bytes], { type: "video/mp4" })),
  });

  assert.equal(result.outcomes[0]?.state, "published");
  const init = JSON.parse(String(seen[0]?.init?.body));
  assert.deepEqual(init, {
    media_category: "tweet_video",
    media_type: "video/mp4",
    total_bytes: size,
  });

  const appends = seen.filter((entry) => entry.url.pathname.endsWith("/append"));
  const received: Uint8Array[] = [];

  for (const append of appends) {
    assert.ok(append.init?.body instanceof FormData);
    const part = append.init.body.get("media");
    assert.ok(part instanceof Blob);
    received.push(new Uint8Array(await part.arrayBuffer()));
  }

  assert.deepEqual(
    received.map((chunk) => chunk.byteLength),
    [xChunkSize, 7],
  );
  assert.deepEqual(new Uint8Array(Buffer.concat(received)), bytes);

  const finalize = seen.find((entry) => entry.url.pathname.endsWith("/finalize"));
  assert.equal(finalize?.init?.body, undefined);

  const status = seen.find((entry) => entry.url.pathname === "/2/media/upload");
  assert.equal(status?.init?.method, "GET");
  assert.equal(status?.url.searchParams.get("command"), "STATUS");
  assert.equal(status?.url.searchParams.get("media_id"), "m1");
});

it("X processing wait never outlives the operation budget", async () => {
  let statusCalls = 0;
  const social = createSocial({
    backend: x({
      auth,
      fetch: chunkedFetch({
        finalize: () =>
          Response.json({
            data: { id: "m1", processing_info: { state: "pending", check_after_secs: 5 } },
          }),
        status: () => {
          statusCalls++;

          return Response.json({ data: { id: "m1" } });
        },
      }),
    }),
  });

  const started = performance.now();
  const result = await social.posts.publish(
    { targets: [{ account }], content: videoContent(videoBlob(10)) },
    { retryBudget: { maxAttempts: 1, maxElapsedMs: 200 } },
  );

  assert.ok(performance.now() - started < 1_000);
  assert.equal(statusCalls, 0);
  assert.notEqual(result.outcomes[0]?.state, "published");
});

it("X processing wait reports cancellation as cancelled", async () => {
  const controller = new AbortController();
  let tweets = 0;
  const adapter = x({
    auth,
    fetch: chunkedFetch({
      finalize: () => {
        setTimeout(() => controller.abort(), 10);

        return Response.json({
          data: { id: "m1", processing_info: { state: "pending", check_after_secs: 1 } },
        });
      },
      tweet: () => {
        tweets++;

        return Response.json({ data: { id: "post" } });
      },
    }),
  });
  const blob = videoBlob(10);

  await assert.rejects(
    () =>
      adapter.posts?.publishTarget(
        { targetIndex: 0, targetKey: "x", account, content: videoContent(blob) },
        {
          backendInstance: "default",
          correlationId: "c",
          retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
          signal: controller.signal,
        },
      ),
    (error: { code?: string }) => error.code === "cancelled",
  );
  assert.equal(tweets, 0);
});

it("X explains an attach-time 403 on a video post", async () => {
  const social = createSocial({
    backend: x({
      auth,
      fetch: chunkedFetch({ tweet: () => new Response("{}", { status: 403 }) }),
    }),
  });

  const result = await social.posts.publish({
    targets: [{ account }],
    content: videoContent(videoBlob(10)),
  });

  assert.equal(result.outcomes[0]?.state, "failed");

  if (result.outcomes[0]?.state === "failed") {
    assert.equal(result.outcomes[0].code, "missing_permission");
    assert.match(result.outcomes[0].message, /duration limit/);
  }
});

it("X rejects empty video and GIF Blobs during preparation", () => {
  const social = createSocial({ backend: x({ auth, fetch: chunkedFetch({}) }) });

  for (const [kind, mimeType] of [
    ["video", "video/mp4"],
    ["image", "image/gif"],
  ] as const) {
    const prepared = social.posts.prepare({
      targets: [{ account }],
      content: {
        text: "Empty",
        media: [
          {
            kind,
            mimeType,
            filename: "empty",
            source: { kind: "blob", blob: new Blob([]), fingerprint: "empty" },
          },
        ],
      },
    });

    assert.equal(prepared.ok, false);
  }
});

it("X native uploadVideo and uploadGif return attachable media IDs", async () => {
  const categories: string[] = [];
  const adapter = x({
    auth,
    fetch: async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname === "/2/media/upload/initialize") {
        categories.push(JSON.parse(String(init?.body)).media_category);

        return Response.json({ data: { id: "native1" } });
      }

      if (url.pathname.endsWith("/append")) return new Response(null, { status: 204 });

      return Response.json({ data: { id: "native1" } });
    },
  });
  const context = {
    backendInstance: "default",
    correlationId: "c",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
  };

  assert.deepEqual(await adapter.native.uploadVideo({ account, video: videoBlob(10), context }), {
    mediaId: "native1",
  });
  assert.deepEqual(await adapter.native.uploadGif({ account, gif: gifBlob(10), context }), {
    mediaId: "native1",
  });
  assert.deepEqual(categories, ["tweet_video", "tweet_gif"]);
});

it("X reports a failure on the final STATUS poll as media_error", async () => {
  let statusCalls = 0;
  const social = createSocial({
    backend: x({
      auth,
      fetch: chunkedFetch({
        finalize: () =>
          Response.json({
            data: { id: "m1", processing_info: { state: "pending", check_after_secs: 0 } },
          }),
        status: () => {
          statusCalls++;

          return Response.json({
            data: {
              id: "m1",
              processing_info: {
                state: statusCalls === 30 ? "failed" : "in_progress",
                check_after_secs: 0,
              },
            },
          });
        },
      }),
    }),
  });

  const result = await social.posts.publish({
    targets: [{ account }],
    content: videoContent(videoBlob(10)),
  });

  assert.equal(statusCalls, 30);
  assert.equal(result.outcomes[0]?.state, "failed");

  if (result.outcomes[0]?.state === "failed") assert.equal(result.outcomes[0].code, "media_error");
});

it("X treats a malformed INITIALIZE response as a definite media failure", async () => {
  let tweets = 0;
  const social = createSocial({
    backend: x({
      auth,
      fetch: async (input) => {
        const url = new URL(String(input));

        if (url.pathname === "/2/media/upload/initialize") return Response.json({ data: {} });

        tweets++;

        return Response.json({ data: { id: "post" } });
      },
    }),
  });

  const result = await social.posts.publish({
    targets: [{ account }],
    content: videoContent(videoBlob(10)),
  });

  assert.equal(tweets, 0);
  assert.equal(result.outcomes[0]?.state, "failed");

  if (result.outcomes[0]?.state === "failed") assert.equal(result.outcomes[0].code, "media_error");
});
