import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { bluesky, type BlueskyOptions } from "../src/platforms/bluesky.js";
import {
  connectedAccountRef,
  SocialError,
  type AdapterOperationContext,
  type JsonObject,
  type JsonValue,
} from "../src/core/index.js";

const did = "did:plc:test";

const account = connectedAccountRef({ backend: "default", platform: "bluesky", accountId: did });

const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

interface Seen {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: BodyInit | null;
}

function json(value: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function context(): AdapterOperationContext {
  return {
    backendInstance: "default",
    correlationId: "test",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
  };
}

function video(size: number): Blob {
  const bytes = new Uint8Array(size);

  for (let index = 0; index < size; index++) bytes[index] = index % 251;

  return new Blob([bytes], { type: "video/mp4" });
}

function job(jobId: string, state = "JOB_STATE_CREATED"): JsonObject {
  return { jobId, did, state };
}

function session(partSizeBytes: number, partCount: number): JsonObject {
  return { jobId: "upload-1", partSizeBytes, partCount, expiresAt: "2026-11-05T00:00:00.000Z" };
}

function routes(overrides: Record<string, (request: Seen) => Response | Promise<Response>> = {}) {
  let tokens = 0;

  return async (request: Seen): Promise<Response> => {
    const method = request.url.pathname.replace("/xrpc/", "");

    const override = overrides[method];

    if (override) return override(request);

    if (method === "com.atproto.server.getServiceAuth") {
      tokens += 1;

      return json({ token: `service-token-${tokens}` });
    }

    if (method === "app.bsky.video.startUpload") return json(session(10, 3));

    if (method === "app.bsky.video.uploadPart") {
      const body = request.body;

      assert.ok(body instanceof Blob);

      return json({
        partNumber: Number(request.url.searchParams.get("partNumber")),
        sizeBytes: body.size,
      });
    }

    if (method === "app.bsky.video.finishUpload")
      return json({ completedJobId: "processing-1", jobStatus: job("processing-1") });

    throw new Error(`unexpected ${request.url.href}`);
  };
}

function harness(
  route: (request: Seen) => Response | Promise<Response>,
  extra: Partial<BlueskyOptions> = {},
) {
  const seen: Seen[] = [];

  const adapter = bluesky({
    auth: { service: "https://pds.example", did, accessJwt: "pds-access-jwt" },
    pdsDid: "did:web:pds.example",
    fetch: async (input, init) => {
      const request = {
        url: new URL(input instanceof Request ? input.url : String(input)),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body ?? null,
      };

      seen.push(request);

      return route(request);
    },
    ...extra,
  });

  const native = adapter.native;

  if (native === undefined) throw new Error("Bluesky native adapter is missing");

  return { adapter, native, seen };
}

function methods(seen: readonly Seen[]): string[] {
  return seen.map(({ url }) => `${url.host}${url.pathname.replace("/xrpc/", " ")}`);
}

async function bytes(body: BodyInit | null): Promise<number[]> {
  assert.ok(body instanceof Blob);

  return [...new Uint8Array(await body.arrayBuffer())];
}

function uploadJobId(error: SocialError): JsonValue | undefined {
  return error.details?.["uploadJobId"];
}

describe("Bluesky multipart video upload", () => {
  it("[feature:bluesky.media.video.multipartUpload] sends app.bsky.video.startUpload, each part in order, and finishUpload with PDS uploadBlob tokens", async () => {
    const before = Math.floor(Date.now() / 1000);

    const { native, seen } = harness(routes());

    const clip = video(25);

    const result = await native.uploadVideoMultipart({
      account,
      video: clip,
      name: "clip.mp4",
      durationMs: 4_000,
      width: 1920,
      height: 1080,
      context: context(),
    });

    assert.deepEqual(result, { jobId: "processing-1", did, state: "JOB_STATE_CREATED" });
    assert.deepEqual(methods(seen), [
      "pds.example com.atproto.server.getServiceAuth",
      "video.bsky.app app.bsky.video.startUpload",
      "video.bsky.app app.bsky.video.uploadPart",
      "video.bsky.app app.bsky.video.uploadPart",
      "video.bsky.app app.bsky.video.uploadPart",
      "pds.example com.atproto.server.getServiceAuth",
      "video.bsky.app app.bsky.video.finishUpload",
    ]);

    for (const index of [0, 5]) {
      const query = seen[index]!.url.searchParams;

      assert.equal(query.get("aud"), "did:web:pds.example");
      assert.equal(query.get("lxm"), "com.atproto.repo.uploadBlob");

      const exp = Number(query.get("exp"));

      assert.ok(Number.isSafeInteger(exp));
      assert.ok(exp >= before + 1800 && exp <= Math.floor(Date.now() / 1000) + 1800);
    }

    const start = seen[1]!;

    assert.equal(start.method, "POST");
    assert.equal(start.headers.get("authorization"), "Bearer service-token-1");
    assert.equal(start.headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(start.body)), {
      sizeBytes: 25,
      mimeType: "video/mp4",
      name: "clip.mp4",
      durationMs: 4_000,
      width: 1920,
      height: 1080,
    });

    const all = [...new Uint8Array(await clip.arrayBuffer())];

    for (const [offset, request] of seen.slice(2, 5).entries()) {
      assert.equal(request.method, "POST");
      assert.equal(request.url.searchParams.get("jobId"), "upload-1");
      assert.equal(request.url.searchParams.get("partNumber"), String(offset + 1));
      assert.equal(request.headers.get("authorization"), "Bearer service-token-1");
      assert.equal(request.headers.get("content-type"), "application/octet-stream");
      assert.deepEqual(await bytes(request.body), all.slice(offset * 10, offset * 10 + 10));
    }

    const finish = seen[6]!;

    assert.equal(finish.headers.get("authorization"), "Bearer service-token-2");
    assert.deepEqual(JSON.parse(String(finish.body)), { jobId: "upload-1" });
  });

  it("mints a new token before a part when the current one is about to expire", async (t) => {
    const realNow = Date.now.bind(Date);

    let offset = 0;

    t.mock.method(Date, "now", () => realNow() + offset);

    const { native, seen } = harness(
      routes({
        "app.bsky.video.uploadPart": (request) => {
          offset += 29.5 * 60 * 1000;

          return json({
            partNumber: Number(request.url.searchParams.get("partNumber")),
            sizeBytes: 10,
          });
        },
        "app.bsky.video.startUpload": () => json(session(10, 2)),
      }),
    );

    await native.uploadVideoMultipart({ account, video: video(20), context: context() });

    assert.deepEqual(methods(seen), [
      "pds.example com.atproto.server.getServiceAuth",
      "video.bsky.app app.bsky.video.startUpload",
      "video.bsky.app app.bsky.video.uploadPart",
      "pds.example com.atproto.server.getServiceAuth",
      "video.bsky.app app.bsky.video.uploadPart",
      "pds.example com.atproto.server.getServiceAuth",
      "video.bsky.app app.bsky.video.finishUpload",
    ]);
    assert.equal(seen[4]!.headers.get("authorization"), "Bearer service-token-2");
  });

  it("reports a failed part as ambiguous with the upload job ID and never aborts or retries", async () => {
    const { native, seen } = harness(
      routes({
        "app.bsky.video.uploadPart": (request) =>
          request.url.searchParams.get("partNumber") === "2"
            ? json({ error: "InternalServerError" }, 500)
            : json({ partNumber: 1, sizeBytes: 10 }),
      }),
    );

    const error = await native
      .uploadVideoMultipart({ account, video: video(25), context: context() })
      .then(
        () => undefined,
        (failure: Error) => failure,
      );

    assert.ok(error instanceof SocialError);
    assert.equal(error.code, "ambiguous_outcome");
    assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });
    assert.equal(uploadJobId(error), "upload-1");
    assert.equal(seen.length, 4);
    assert.ok(seen.every(({ url }) => !url.pathname.endsWith("abortUpload")));
  });

  it("refuses a part plan that does not match the video size before sending parts", async () => {
    const { native, seen } = harness(
      routes({ "app.bsky.video.startUpload": () => json(session(10, 2)) }),
    );

    const error = await native
      .uploadVideoMultipart({ account, video: video(25), context: context() })
      .then(
        () => undefined,
        (failure: Error) => failure,
      );

    assert.ok(error instanceof SocialError);
    assert.equal(error.code, "upstream_failure");
    assert.equal(uploadJobId(error), "upload-1");
    assert.equal(seen.length, 2);
  });

  it("treats a part receipt with the wrong size as ambiguous", async () => {
    const { native } = harness(
      routes({ "app.bsky.video.uploadPart": () => json({ partNumber: 1, sizeBytes: 9 }) }),
    );

    await assert.rejects(
      native.uploadVideoMultipart({ account, video: video(25), context: context() }),
      (error: SocialError) =>
        error instanceof SocialError &&
        error.code === "ambiguous_outcome" &&
        uploadJobId(error) === "upload-1",
    );
  });

  it("rejects invalid input before any request", async () => {
    const { native, seen } = harness(() => {
      throw new Error("must not send");
    });

    const inputs = [
      { video: new Blob([new Uint8Array(8)], { type: "video/quicktime" }) },
      { video: video(0) },
      { video: video(8), name: "a/b.mp4" },
      { video: video(8), durationMs: 1.5 },
      { video: video(8), width: -1 },
    ];

    for (const input of inputs)
      await assert.rejects(
        native.uploadVideoMultipart({ account, context: context(), ...input }),
        (error: SocialError) => error instanceof SocialError && error.code === "invalid_input",
      );

    await assert.rejects(
      native.uploadVideoPart({ account, jobId: "upload-1", partNumber: 0, part: video(4) }),
      (error: SocialError) => error instanceof SocialError && error.code === "invalid_input",
    );
    await assert.rejects(
      native.getVideoUploadStatus({ account, jobId: "bad id" }),
      (error: SocialError) => error instanceof SocialError && error.code === "invalid_input",
    );
    await assert.rejects(
      native.startVideoUpload({ account, sizeBytes: 300_000_001 }),
      (error: SocialError) => error instanceof SocialError && error.code === "invalid_input",
    );
    assert.equal(seen.length, 0);
  });

  it("exposes each step for resuming an upload", async () => {
    const { native, seen } = harness(
      routes({
        "app.bsky.video.getUploadStatus": () =>
          json({
            jobId: "upload-1",
            partSizeBytes: 10,
            partCount: 3,
            receivedParts: [1, 3],
            expiresAt: "2026-11-05T00:00:00.000Z",
            state: "created",
          }),
        "app.bsky.video.abortUpload": () => json({ state: "aborted" }),
      }),
    );

    const started = await native.startVideoUpload({
      account,
      sizeBytes: 25,
      name: "clip.mp4",
      context: context(),
    });

    assert.deepEqual(started, {
      jobId: "upload-1",
      partSizeBytes: 10,
      partCount: 3,
      expiresAt: "2026-11-05T00:00:00.000Z",
    });

    const status = await native.getVideoUploadStatus({
      account,
      jobId: "upload-1",
      context: context(),
    });

    assert.deepEqual(status.receivedParts, [1, 3]);
    assert.equal(status.state, "created");

    const receipt = await native.uploadVideoPart({
      account,
      jobId: "upload-1",
      partNumber: 2,
      part: video(10),
      context: context(),
    });

    assert.deepEqual(receipt, { partNumber: 2, sizeBytes: 10 });

    const finished = await native.finishVideoUpload({
      account,
      jobId: "upload-1",
      context: context(),
    });

    assert.equal(finished.jobId, "processing-1");

    const aborted = await native.abortVideoUpload({
      account,
      jobId: "upload-1",
      context: context(),
    });

    assert.deepEqual(aborted, { state: "aborted" });
    assert.deepEqual(
      methods(seen).filter((entry) => entry.startsWith("video.")),
      [
        "video.bsky.app app.bsky.video.startUpload",
        "video.bsky.app app.bsky.video.getUploadStatus",
        "video.bsky.app app.bsky.video.uploadPart",
        "video.bsky.app app.bsky.video.finishUpload",
        "video.bsky.app app.bsky.video.abortUpload",
      ],
    );

    const statusRequest = seen.find(({ url }) => url.pathname.endsWith("getUploadStatus"));

    assert.equal(statusRequest?.method, "GET");
    assert.equal(statusRequest?.url.searchParams.get("jobId"), "upload-1");
    assert.equal(statusRequest?.headers.get("authorization"), "Bearer service-token-2");

    const abortRequest = seen.find(({ url }) => url.pathname.endsWith("abortUpload"));

    assert.deepEqual(JSON.parse(String(abortRequest?.body)), { jobId: "upload-1" });
  });

  it("reads a completed upload status and binds its job to the account", async () => {
    const { native } = harness(
      routes({
        "app.bsky.video.getUploadStatus": () =>
          json({
            jobId: "upload-1",
            partSizeBytes: 10,
            partCount: 1,
            receivedParts: [1],
            expiresAt: "2026-11-05T00:00:00.000Z",
            state: "completed",
            completedJobId: "processing-9",
            jobStatus: {
              ...job("processing-9", "JOB_STATE_COMPLETED"),
              blob: { $type: "blob", ref: { $link: cid }, mimeType: "video/mp4", size: 2048 },
            },
          }),
      }),
    );

    const status = await native.getVideoUploadStatus({
      account,
      jobId: "upload-1",
      context: context(),
    });

    assert.equal(status.completedJobId, "processing-9");
    assert.equal(status.job?.state, "JOB_STATE_COMPLETED");
    assert.equal(status.job?.blob?.["size"], 2048);
  });

  it("uses the multipart upload from media.upload for videos over 50,000,000 bytes", async () => {
    const { adapter, seen } = harness(
      routes({
        "app.bsky.video.startUpload": () => json(session(25_000_000, 3)),
        "app.bsky.video.uploadPart": (request) => {
          const body = request.body;

          assert.ok(body instanceof Blob);

          return json({
            partNumber: Number(request.url.searchParams.get("partNumber")),
            sizeBytes: body.size,
          });
        },
      }),
    );

    const large = new Blob([new Uint8Array(50_000_001)], { type: "video/mp4" });

    const ref = await adapter.media!.upload(
      {
        kind: "video",
        mimeType: "video/mp4",
        source: { kind: "blob", blob: large, fingerprint: "large-clip" },
      },
      account,
      context(),
    );

    assert.equal(ref.mediaId, "processing-1");
    assert.deepEqual(
      seen
        .filter(({ url }) => url.pathname.endsWith("uploadPart"))
        .map(({ body }) => (body instanceof Blob ? body.size : 0)),
      [25_000_000, 25_000_000, 1],
    );
    assert.ok(seen.every(({ url }) => !url.pathname.endsWith("uploadVideo")));
  });
});
