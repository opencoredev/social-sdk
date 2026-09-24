/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/require-readable-spacing -- validated external boundary or fixture contract. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createSocial } from "../src/index.js";
import { bluesky, type BlueskyOptions } from "../src/platforms/bluesky.js";
import {
  connectedAccountRef,
  SocialError,
  type AdapterOperationContext,
  type MediaRef,
} from "../src/core/index.js";

const did = "did:plc:test";
const account = connectedAccountRef({ backend: "default", platform: "bluesky", accountId: did });
const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const processedBlob = {
  $type: "blob",
  ref: { $link: cid },
  mimeType: "video/mp4",
  size: 2048,
};

interface Seen {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body?: BodyInit | null;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
function json(value: unknown, status = 200): Response {
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

function mp4(size = 1024, type = "video/mp4"): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

function harness(
  route: (request: Seen) => Response | Promise<Response>,
  extra: Partial<BlueskyOptions> = {},
) {
  const seen: Seen[] = [];
  const adapter = bluesky({
    auth: { service: "https://pds.example", did, accessJwt: "pds-access-jwt" },
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
  return { adapter, seen };
}

interface JobExtras {
  readonly progress?: number;
  readonly blob?: object;
  readonly failureCode?: string;
  readonly error?: string;
  readonly message?: string;
}

function job(state: string, extra: JobExtras = {}) {
  return { jobId: "job-1", did, state, ...extra };
}

describe("Bluesky video upload", () => {
  it("uploads with a PDS-scoped service token and returns the job without polling", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { adapter, seen } = harness(({ url }) => {
      if (url.pathname === "/xrpc/com.atproto.server.getSession")
        return json({
          did,
          handle: "alice.example",
          didDoc: {
            id: did,
            service: [
              {
                id: "#atproto_pds",
                type: "AtprotoPersonalDataServer",
                serviceEndpoint: "https://morel.us-east.host.bsky.network",
              },
            ],
          },
        });
      if (url.pathname === "/xrpc/com.atproto.server.getServiceAuth")
        return json({ token: "service-token" });
      if (url.pathname === "/xrpc/app.bsky.video.uploadVideo")
        return json(job("JOB_STATE_CREATED", { progress: 0 }));
      throw new Error(`unexpected ${url.href}`);
    });

    const result = await adapter.native!.uploadVideo({
      account,
      video: mp4(),
      name: "clip.mp4",
      context: context(),
    });

    assert.deepEqual(result, { jobId: "job-1", did, state: "JOB_STATE_CREATED", progress: 0 });
    assert.deepEqual(
      seen.map(({ url }) => `${url.host}${url.pathname}`),
      [
        "pds.example/xrpc/com.atproto.server.getSession",
        "pds.example/xrpc/com.atproto.server.getServiceAuth",
        "video.bsky.app/xrpc/app.bsky.video.uploadVideo",
      ],
    );

    const auth = seen[1]!.url.searchParams;
    assert.equal(auth.get("aud"), "did:web:morel.us-east.host.bsky.network");
    assert.equal(auth.get("lxm"), "com.atproto.repo.uploadBlob");
    const exp = Number(auth.get("exp"));
    assert.ok(Number.isSafeInteger(exp));
    assert.ok(exp >= before + 1800 && exp <= Math.floor(Date.now() / 1000) + 1800);

    const upload = seen[2]!;
    assert.equal(upload.method, "POST");
    assert.equal(upload.url.searchParams.get("did"), did);
    assert.equal(upload.url.searchParams.get("name"), "clip.mp4");
    assert.equal(upload.headers.get("authorization"), "Bearer service-token");
    assert.equal(upload.headers.get("content-type"), "video/mp4");
    assert.ok(upload.body instanceof Blob);
  });

  it("uses a configured PDS DID and reads the lexicon's wrapped job status", async () => {
    const { adapter, seen } = harness(
      ({ url }) =>
        url.pathname.endsWith("getServiceAuth")
          ? json({ token: "service-token" })
          : json({ jobStatus: job("JOB_STATE_ENCODING", { progress: 40 }) }),
      { pdsDid: "did:web:pds.example", videoService: "https://video.example" },
    );

    const result = await adapter.native!.uploadVideo({
      account,
      video: mp4(),
      context: context(),
    });

    assert.equal(result.state, "JOB_STATE_ENCODING");
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.url.searchParams.get("aud"), "did:web:pds.example");
    assert.equal(seen[1]!.url.host, "video.example");
    assert.equal(seen[1]!.url.searchParams.get("name"), "video.mp4");
  });

  it("returns the existing blob when the service reports already_exists", async () => {
    const { adapter } = harness(
      ({ url }) =>
        url.pathname.endsWith("getServiceAuth")
          ? json({ token: "service-token" })
          : json(
              job("JOB_STATE_COMPLETED", {
                error: "already_exists",
                message: "already_exists",
                blob: processedBlob,
              }),
              409,
            ),
      { pdsDid: "did:web:pds.example" },
    );

    const result = await adapter.native!.uploadVideo({
      account,
      video: mp4(),
      context: context(),
    });

    assert.deepEqual(result.blob, processedBlob);
    assert.equal(result.error, "already_exists");
  });

  it("rejects invalid video input before any request", async () => {
    const { adapter, seen } = harness(() => {
      throw new Error("must not send");
    });

    for (const video of [mp4(1024, "video/quicktime"), mp4(0), mp4(16, "")])
      await assert.rejects(
        adapter.native!.uploadVideo({ account, video, context: context() }),
        (error: SocialError) => error instanceof SocialError && error.code === "invalid_input",
      );

    const oversized = mp4(1);
    Object.defineProperty(oversized, "size", { value: 300_000_001 });
    await assert.rejects(
      adapter.native!.uploadVideo({ account, video: oversized, context: context() }),
      (error: SocialError) => error instanceof SocialError && error.code === "invalid_input",
    );
    await assert.rejects(
      adapter.native!.uploadVideo({ account, video: mp4(), name: "a/b.mp4", context: context() }),
      (error: SocialError) => error instanceof SocialError && error.code === "invalid_input",
    );
    await assert.rejects(
      adapter.native!.uploadVideo({
        account: connectedAccountRef({
          backend: "default",
          platform: "bluesky",
          accountId: "did:plc:other",
        }),
        video: mp4(),
        context: context(),
      }),
      (error: SocialError) => error instanceof SocialError && error.code === "unauthorized",
    );
    assert.equal(seen.length, 0);
  });

  it("reports a lost upload response as ambiguous", async () => {
    const { adapter } = harness(
      ({ url }) => {
        if (url.pathname.endsWith("getServiceAuth")) return json({ token: "service-token" });
        throw new TypeError("socket closed");
      },
      { pdsDid: "did:web:pds.example" },
    );

    await assert.rejects(
      adapter.native!.uploadVideo({ account, video: mp4(), context: context() }),
      (error: SocialError) =>
        error instanceof SocialError &&
        error.code === "ambiguous_outcome" &&
        error.retryDisposition.kind === "reconcile-first",
    );
  });

  it("requires pdsDid when the session has no DID document", async () => {
    const { adapter, seen } = harness(() => json({ did, handle: "alice.example" }));

    await assert.rejects(
      adapter.native!.uploadVideo({ account, video: mp4(), context: context() }),
      (error: SocialError) => error instanceof SocialError && error.code === "invalid_config",
    );
    assert.equal(seen.length, 1);
  });

  it("rejects a video service that is not an HTTPS origin", () => {
    for (const videoService of ["http://video.example", "https://video.example/path", "nope"])
      assert.throws(
        () =>
          bluesky({
            auth: { service: "https://pds.example", did, accessJwt: "jwt" },
            videoService,
          }),
        (error: SocialError) => error instanceof SocialError && error.code === "invalid_config",
      );
  });
});

describe("Bluesky video job status and limits", () => {
  it("reads job status once without sending account credentials", async () => {
    const { adapter, seen } = harness(() =>
      json({ jobStatus: job("JOB_STATE_COMPLETED", { blob: processedBlob }) }),
    );

    const result = await adapter.native!.getVideoJobStatus({
      account,
      jobId: "job-1",
      context: context(),
    });

    assert.deepEqual(result.blob, processedBlob);
    assert.equal(seen.length, 1);
    assert.equal(
      seen[0]!.url.href,
      "https://video.bsky.app/xrpc/app.bsky.video.getJobStatus?jobId=job-1",
    );
    assert.equal(seen[0]!.headers.has("authorization"), false);
  });

  it("rejects a job owned by another DID and malformed blobs", async () => {
    const other = harness(() =>
      json({ jobStatus: { ...job("JOB_STATE_CREATED"), did: "did:plc:x" } }),
    );
    await assert.rejects(
      other.adapter.native!.getVideoJobStatus({ account, jobId: "job-1", context: context() }),
      (error: SocialError) => error instanceof SocialError && error.code === "unauthorized",
    );

    const malformed = harness(() =>
      json({
        jobStatus: job("JOB_STATE_COMPLETED", {
          blob: { ...processedBlob, mimeType: "image/png" },
        }),
      }),
    );
    await assert.rejects(
      malformed.adapter.native!.getVideoJobStatus({ account, jobId: "job-1", context: context() }),
      (error: SocialError) => error instanceof SocialError && error.code === "media_error",
    );
  });

  it("reads upload limits with a video-service token", async () => {
    const { adapter, seen } = harness(({ url }) =>
      url.pathname.endsWith("getServiceAuth")
        ? json({ token: "limits-token" })
        : json({ canUpload: true, remainingDailyVideos: 24, remainingDailyBytes: 1_000_000 }),
    );

    const limits = await adapter.native!.getVideoUploadLimits({ account, context: context() });

    assert.deepEqual(limits, {
      canUpload: true,
      remainingDailyVideos: 24,
      remainingDailyBytes: 1_000_000,
    });
    assert.equal(seen[0]!.url.searchParams.get("aud"), "did:web:video.bsky.app");
    assert.equal(seen[0]!.url.searchParams.get("lxm"), "app.bsky.video.getUploadLimits");
    assert.equal(seen[0]!.url.searchParams.has("exp"), false);
    assert.equal(seen[1]!.url.pathname, "/xrpc/app.bsky.video.getUploadLimits");
    assert.equal(seen[1]!.headers.get("authorization"), "Bearer limits-token");
  });

  it("requests service tokens through an OAuth session's fetchHandler", async () => {
    const pds: { readonly pathname: string; readonly authorization: string | null }[] = [];
    const { adapter, seen } = harness(
      ({ url }) =>
        url.pathname.endsWith("getUploadLimits")
          ? json({ canUpload: true })
          : json(job("JOB_STATE_CREATED")),
      {
        auth: { service: "https://untrusted-configured-service.example", did },
        session: {
          did,
          fetchHandler: async (pathname, init) => {
            pds.push({ pathname, authorization: new Headers(init?.headers).get("authorization") });
            return json({ token: "session-service-token" });
          },
        },
        pdsDid: "did:web:pds.example",
      },
    );

    await adapter.native!.getVideoUploadLimits({ account, context: context() });
    await adapter.native!.uploadVideo({
      account,
      video: mp4(),
      name: "clip.mp4",
      context: context(),
    });

    assert.deepEqual(
      pds.map(({ pathname }) => new URL(pathname, "https://pds.invalid").pathname),
      ["/xrpc/com.atproto.server.getServiceAuth", "/xrpc/com.atproto.server.getServiceAuth"],
    );
    assert.ok(pds.every(({ authorization }) => authorization === null));
    assert.deepEqual(
      seen.map(({ url }) => `${url.host}${url.pathname}`),
      [
        "video.bsky.app/xrpc/app.bsky.video.getUploadLimits",
        "video.bsky.app/xrpc/app.bsky.video.uploadVideo",
      ],
    );
    assert.ok(
      seen.every(({ headers }) => headers.get("authorization") === "Bearer session-service-token"),
    );
  });
});

describe("Bluesky video publishing", () => {
  const videoRef: MediaRef = {
    kind: "media",
    version: 1,
    backend: "default",
    platform: "bluesky",
    accountId: did,
    mediaId: "job-1",
  };

  it("returns the job ID from media.upload and publishes an app.bsky.embed.video record", async () => {
    let status = "JOB_STATE_ENCODING";
    const { adapter, seen } = harness(
      ({ url, body }) => {
        if (url.pathname.endsWith("getServiceAuth")) return json({ token: "service-token" });
        if (url.pathname.endsWith("uploadVideo")) return json(job("JOB_STATE_CREATED"));
        if (url.pathname.endsWith("getJobStatus"))
          return json({
            jobStatus:
              status === "JOB_STATE_COMPLETED"
                ? job(status, { blob: processedBlob })
                : job(status, { progress: 50 }),
          });
        if (url.pathname.endsWith("createRecord")) {
          const record = JSON.parse(String(body))["record"];
          assert.deepEqual(record["embed"], {
            $type: "app.bsky.embed.video",
            video: processedBlob,
            alt: "A short demo",
            aspectRatio: { width: 1920, height: 1080 },
          });
          assert.equal(record["text"], "Watch this");
          return json({ uri: `at://${did}/app.bsky.feed.post/3kvideo`, cid: "bafyrecord" });
        }
        throw new Error(`unexpected ${url.href}`);
      },
      { pdsDid: "did:web:pds.example" },
    );
    const social = createSocial({ backend: adapter });

    const ref = await social.media.upload(
      {
        kind: "video",
        source: { kind: "blob", blob: mp4(), fingerprint: "clip" },
        mimeType: "video/mp4",
      },
      account,
    );
    assert.deepEqual(ref, videoRef);

    const content = {
      text: "Watch this",
      media: [
        {
          kind: "video" as const,
          source: { kind: "media-ref" as const, ref },
          altText: "A short demo",
          width: 1920,
          height: 1080,
        },
      ],
    };

    const pending = await social.posts.publish({ targets: [{ account }], content });
    const waiting = pending.outcomes[0];
    assert.equal(waiting?.state, "failed");
    assert.equal(waiting?.state === "failed" && waiting.code, "media_error");
    assert.deepEqual(waiting?.state === "failed" && waiting.retryDisposition, {
      kind: "after-delay",
      delayMs: 1000,
    });
    assert.equal(seen.filter(({ url }) => url.pathname.endsWith("getJobStatus")).length, 1);
    assert.equal(
      seen.some(({ url }) => url.pathname.endsWith("createRecord")),
      false,
    );

    status = "JOB_STATE_COMPLETED";
    const result = await social.posts.publish({ targets: [{ account }], content });

    assert.equal(result.outcomes[0]?.state, "published");
    assert.equal(seen.filter(({ url }) => url.pathname.endsWith("getJobStatus")).length, 2);
    assert.equal(seen.filter(({ url }) => url.pathname.endsWith("createRecord")).length, 1);
  });

  it("reports a failed processing job without creating a post", async () => {
    const { adapter, seen } = harness(() =>
      json({ jobStatus: job("JOB_STATE_FAILED", { failureCode: "encoding_failure" }) }),
    );
    const social = createSocial({ backend: adapter });

    const result = await social.posts.publish({
      targets: [{ account }],
      content: { media: [{ kind: "video", source: { kind: "media-ref", ref: videoRef } }] },
    });

    const outcome = result.outcomes[0];
    assert.equal(outcome?.state, "failed");
    assert.equal(outcome?.state === "failed" && outcome.code, "media_error");
    assert.deepEqual(outcome?.state === "failed" && outcome.retryDisposition, { kind: "never" });
    assert.equal(seen.length, 1);
  });

  it("rejects unsupported video combinations during preparation without network access", async () => {
    const { adapter, seen } = harness(() => {
      throw new Error("must not send");
    });
    const social = createSocial({ backend: adapter });
    const image = {
      kind: "image" as const,
      source: { kind: "https-url" as const, url: "https://cdn.example/a.png" },
    };
    const video = { kind: "video" as const, source: { kind: "media-ref" as const, ref: videoRef } };

    const cases = [
      [
        "media.video_ref_required",
        [
          {
            kind: "video" as const,
            source: { kind: "blob" as const, blob: mp4(), fingerprint: "x" },
          },
        ],
      ],
      ["media.mixed", [video, image]],
      ["media.mixed", [video, video]],
      [
        "media.video_owner",
        [
          {
            ...video,
            source: { kind: "media-ref" as const, ref: { ...videoRef, accountId: "did:plc:x" } },
          },
        ],
      ],
      ["media.aspect_ratio", [{ ...video, width: 1920 }]],
    ] as const;

    for (const [code, media] of cases)
      await assert.rejects(
        social.posts.publish({ targets: [{ account }], content: { media: [...media] } }),
        (error: SocialError) =>
          error instanceof SocialError &&
          error.code === "invalid_input" &&
          (error.issues ?? []).some((issue) => issue.code === code),
        code,
      );
    assert.equal(seen.length, 0);
  });

  it("rejects non-video media in media.upload before any request", async () => {
    const { adapter, seen } = harness(() => {
      throw new Error("must not send");
    });
    const social = createSocial({ backend: adapter });

    await assert.rejects(
      social.media.upload(
        { kind: "video", source: { kind: "https-url", url: "https://cdn.example/a.mp4" } },
        account,
      ),
      (error: SocialError) => error instanceof SocialError && error.code === "invalid_input",
    );
    await assert.rejects(
      social.media.upload(
        { kind: "image", source: { kind: "blob", blob: mp4(10, "image/png"), fingerprint: "i" } },
        account,
      ),
      (error: SocialError) => error instanceof SocialError && error.code === "invalid_input",
    );
    assert.equal(seen.length, 0);
  });

  it("declares video publishing and the explicit job operations", () => {
    const { adapter } = harness(() => json({}));
    const available = adapter.capabilities.capabilities
      .filter((entry) => entry.availability === "available")
      .map((entry) => entry.operation);

    for (const operation of [
      "posts.publish.video",
      "media.upload",
      "media.video",
      "media.status",
      "media.limits.read",
    ])
      assert.ok(available.includes(operation), operation);
  });
});
