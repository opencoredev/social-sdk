import { test } from "node:test";
import assert from "node:assert/strict";
import { openAsBlob } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryPinterestWorkflowStore,
  pinterest,
  type PinterestOptions,
  type PinterestVideoWorkflow,
} from "../src/platforms/pinterest.js";
import {
  connectedAccountRef,
  createSocial,
  platformPostRef,
  type AdapterOperationContext,
  type DeliveryOutcome,
  type JsonObject,
  type MediaAttachment,
  type PreparedPublishTarget,
} from "../src/core/index.js";
import { SocialError } from "../src/core/errors.js";
import { isJsonValue, parseJson } from "../src/transport/json.js";
import { isJsonObject } from "../src/transport/validation.js";

// Fixtures follow the response shapes and examples in Pinterest's OpenAPI description 5.32.0
// (github.com/pinterest/api-description v5/openapi.json, commit 5c6c1fc, read 2026-11-25).
// No live request was made. IDs, URLs and S3 parameters are synthetic; no credential appears.
const fixtures = {
  userAccount: {
    id: "2783136121146311751",
    username: "fixture_maker",
    account_type: "BUSINESS",
    business_name: "Fixture Studio",
    website_url: "https://example.test",
    profile_image: "https://i.pinimg.example/avatar.jpg",
    follower_count: 10,
  },
  pin: {
    id: "813744226420795884",
    created_at: "2026-11-25T12:00:00",
    board_id: "549755885175",
    title: "Autumn table",
    description: "Set the table",
    link: "https://example.test/autumn",
    is_owner: true,
  },
  boardsPage: {
    items: [
      {
        id: "549755885175",
        name: "Summer recipes",
        description: "My favorite summer recipes",
        privacy: "PUBLIC",
        pin_count: 5,
        follower_count: 13,
        owner: { username: "fixture_maker" },
      },
    ],
    bookmark: "ZmlsdGVyOjE=",
  },
  mediaRegistration: {
    media_id: "12345",
    media_type: "video",
    upload_url: "https://pinterest-media-upload.s3-accelerate.amazonaws.com/",
    upload_parameters: {
      "Content-Type": "multipart/form-data",
      key: "uploads/11/aa/22/3:video:fixture",
      policy: "fixture-policy",
      "x-amz-algorithm": "AWS4-HMAC-SHA256",
      "x-amz-credential": "fixture-credential",
      "x-amz-date": "20261125T120000Z",
      "x-amz-security-token": "fixture-session",
      "x-amz-signature": "fixture-signature",
    },
  },
  media: (status: string) => ({ media_id: "12345", media_type: "video", status }),
  error: (code: number, message: string) => ({ code, message }),
} as const;

const accountId = fixtures.userAccount.id;

const account = connectedAccountRef({ backend: "default", platform: "pinterest", accountId });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "fixture",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
};

interface Recorded {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  json?: JsonObject;
  form?: FormData;
  size?: number;
}

/** Fake fetch keyed by "METHOD host/path"; each key answers its queued replies in order. */
function route(replies: Record<string, readonly Response[]>) {
  const calls: Recorded[] = [];
  const queues = new Map(Object.entries(replies).map(([key, value]) => [key, [...value]]));

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const recorded: Recorded = { method, url, headers };
    const hasBody = init?.body !== undefined && init.body !== null;

    const bytes = hasBody
      ? new Uint8Array(await new Response(init?.body).arrayBuffer())
      : undefined;

    if (bytes !== undefined) recorded.size = bytes.byteLength;

    const contentType = headers.get("content-type") ?? "";

    if (bytes !== undefined && contentType.startsWith("multipart/form-data"))
      recorded.form = await new Response(bytes, {
        headers: { "content-type": contentType },
      }).formData();
    else if (hasBody && headers.get("content-type") === "application/json") {
      const parsed = parseJson(new TextDecoder().decode(bytes));

      if (isJsonValue(parsed) && isJsonObject(parsed)) recorded.json = parsed;
    }

    calls.push(recorded);
    const reply = queues.get(method + " " + url.host + url.pathname)?.shift();

    if (reply === undefined) throw new Error("Unexpected request " + method + " " + url.href);

    return reply;
  };

  return { fetch, calls };
}

const json = (body: JsonObject, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function client(fetch: typeof globalThis.fetch, extra: Partial<PinterestOptions> = {}) {
  const adapter = pinterest({ auth: { accessToken: "fixture-token", accountId }, fetch, ...extra });

  return { adapter, social: createSocial({ backend: adapter }) };
}

const api = "api.pinterest.com";

const imageUrl = {
  kind: "image" as const,
  source: { kind: "https-url" as const, url: "https://cdn.example.test/a.jpg" },
};

function only(outcomes: readonly DeliveryOutcome[]): DeliveryOutcome {
  assert.equal(outcomes.length, 1);
  const [outcome] = outcomes;
  assert.ok(outcome);

  return outcome;
}

test("[feature:pinterest.publish.image] an image Pin posts image_url, board, title, link and alt text", async () => {
  const { fetch, calls } = route({ ["POST " + api + "/v5/pins"]: [json(fixtures.pin, 201)] });
  const { social } = client(fetch);

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "549755885175", title: "Autumn table" } }],
    content: {
      text: "Set the table",
      link: { url: "https://example.test/autumn" },
      media: [{ ...imageUrl, altText: "A set table" }],
    },
  });

  const outcome = only(result.outcomes);
  assert.equal(outcome.state, "published");
  assert.ok(outcome.state === "published");
  assert.equal(outcome.post.postId, fixtures.pin.id);
  assert.equal(outcome.url, "https://www.pinterest.com/pin/813744226420795884/");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer fixture-token");
  assert.deepEqual(calls[0]?.json, {
    board_id: "549755885175",
    media_source: { source_type: "image_url", url: "https://cdn.example.test/a.jpg" },
    title: "Autumn table",
    description: "Set the table",
    link: "https://example.test/autumn",
    alt_text: "A set table",
  });
});

test("[feature:pinterest.publish.carousel] two to five image URLs become multiple_image_urls", async () => {
  const { fetch, calls } = route({ ["POST " + api + "/v5/pins"]: [json(fixtures.pin, 201)] });
  const { social } = client(fetch);

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "549755885175", boardSectionId: "77" } }],
    content: {
      media: [
        { ...imageUrl, caption: "First" },
        { kind: "image", source: { kind: "https-url", url: "https://cdn.example.test/b.png" } },
      ],
    },
  });

  assert.equal(only(result.outcomes).state, "published");
  assert.deepEqual(calls[0]?.json, {
    board_id: "549755885175",
    board_section_id: "77",
    media_source: {
      source_type: "multiple_image_urls",
      items: [
        { url: "https://cdn.example.test/a.jpg", description: "First" },
        { url: "https://cdn.example.test/b.png" },
      ],
    },
  });
});

test("[feature:pinterest.publish.image_base64] Blob images go as base64 only with imageBase64", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const blob = new Blob([bytes], { type: "image/jpeg" });

  const media = [
    { kind: "image" as const, source: { kind: "blob" as const, blob, fingerprint: "a" } },
  ];

  const off = client(route({}).fetch);

  const rejected = await off.social.posts.prepare({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media },
  });

  assert.equal(rejected.ok, false);

  const { fetch, calls } = route({ ["POST " + api + "/v5/pins"]: [json(fixtures.pin, 201)] });
  const { social } = client(fetch, { imageBase64: true });

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media },
  });

  assert.equal(only(result.outcomes).state, "published");
  assert.deepEqual(calls[0]?.json?.["media_source"], {
    source_type: "image_base64",
    content_type: "image/jpeg",
    data: Buffer.from(bytes).toString("base64"),
  });

  const pair = route({ ["POST " + api + "/v5/pins"]: [json(fixtures.pin, 201)] });
  const second = client(pair.fetch, { imageBase64: true });

  await second.social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: {
      media: [
        ...media,
        {
          kind: "image",
          source: {
            kind: "blob",
            blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
            fingerprint: "b",
          },
        },
      ],
    },
  });

  assert.deepEqual(pair.calls[0]?.json?.["media_source"], {
    source_type: "multiple_image_base64",
    items: [
      { content_type: "image/jpeg", data: Buffer.from(bytes).toString("base64") },
      { content_type: "image/png", data: "AQ==" },
    ],
  });
});

test("preparation rejects what Pinterest would refuse, before any request", async () => {
  const { adapter } = client(route({}).fetch, { imageBase64: true });

  const issues = (
    options: JsonObject,
    content: PreparedPublishTarget["content"],
    extra: Partial<PreparedPublishTarget> = {},
  ) =>
    adapter
      .posts!.prepareTarget({ targetIndex: 0, targetKey: "0", account, content, options, ...extra })
      .map((issue) => issue.code);

  assert.deepEqual(issues({}, { media: [imageUrl] }), ["pinterest.board"]);
  assert.deepEqual(issues({ boardId: "1", privacy: "SECRET" }, { media: [imageUrl] }), [
    "pinterest.option",
  ]);
  assert.deepEqual(issues({ boardId: "1", title: "t".repeat(101) }, { media: [imageUrl] }), [
    "pinterest.title",
  ]);
  assert.deepEqual(issues({ boardId: "1", link: "ftp://example.test" }, { media: [imageUrl] }), [
    "pinterest.link",
  ]);
  assert.deepEqual(issues({ boardId: "1" }, { text: "x".repeat(801), media: [imageUrl] }), [
    "pinterest.description",
  ]);
  assert.deepEqual(issues({ boardId: "1" }, { text: "text only" }), ["pinterest.media"]);
  assert.deepEqual(issues({ boardId: "1" }, { media: Array.from({ length: 6 }, () => imageUrl) }), [
    "pinterest.media",
  ]);
  assert.deepEqual(issues({ boardId: "1" }, { media: [{ ...imageUrl, altText: "a" }, imageUrl] }), [
    "pinterest.alt_text",
  ]);
  assert.deepEqual(
    issues(
      { boardId: "1" },
      {
        media: [
          imageUrl,
          {
            kind: "image",
            source: { kind: "blob", blob: new Blob([], { type: "image/png" }), fingerprint: "x" },
          },
        ],
      },
    ),
    ["pinterest.image_source"],
  );
  assert.deepEqual(
    issues(
      { boardId: "1" },
      {
        media: [
          {
            kind: "image",
            source: { kind: "blob", blob: new Blob([], { type: "image/gif" }), fingerprint: "x" },
          },
        ],
      },
    ),
    ["pinterest.image_type"],
  );
  assert.deepEqual(
    issues(
      { boardId: "1" },
      { media: [imageUrl] },
      {
        account: connectedAccountRef({ backend: "default", platform: "pinterest", accountId: "9" }),
      },
    ),
    ["pinterest.account"],
  );
  assert.deepEqual(
    issues({ boardId: "1" }, { media: [imageUrl] }, { schedule: { at: "2026-12-01T00:00:00Z" } }),
    ["pinterest.schedule"],
  );
});

const video = (extra: Partial<MediaAttachment> = {}): MediaAttachment => ({
  kind: "video" as const,
  mimeType: "video/mp4",
  durationSeconds: 12,
  source: {
    kind: "blob" as const,
    blob: new Blob([new Uint8Array([0, 0, 0, 24])], { type: "video/mp4" }),
    fingerprint: "v",
  },
  thumbnail: { kind: "https-url" as const, url: "https://cdn.example.test/cover.jpg" },
  ...extra,
});

function videoWithoutCover(): MediaAttachment {
  const { thumbnail: _cover, ...rest } = video();

  return rest;
}

const s3 = "pinterest-media-upload.s3-accelerate.amazonaws.com";

test("a video Pin needs an HTTPS cover thumbnail", () => {
  const { adapter } = client(route({}).fetch);

  const codes = adapter
    .posts!.prepareTarget({
      targetIndex: 0,
      targetKey: "0",
      account,
      content: { media: [videoWithoutCover()] },
      options: { boardId: "1" },
    })
    .map((issue) => issue.code);

  assert.deepEqual(codes, ["pinterest.cover"]);
});

test("[feature:pinterest.publish.video] a video registers media, uploads to S3, reads status once and creates the Pin", async () => {
  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [json(fixtures.media("succeeded"))],
    ["POST " + api + "/v5/pins"]: [json(fixtures.pin, 201)],
  });

  const { social } = client(fetch);

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "549755885175", title: "Clip" } }],
    content: { text: "Watch", media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.equal(outcome.state, "published");
  assert.deepEqual(
    calls.map((call) => call.method + " " + call.url.host + call.url.pathname),
    [
      "POST " + api + "/v5/media",
      "POST " + s3 + "/",
      "GET " + api + "/v5/media/12345",
      "POST " + api + "/v5/pins",
    ],
  );
  assert.deepEqual(calls[0]?.json, { media_type: "video" });
  const upload = calls[1];
  assert.equal(upload?.headers.get("authorization"), null);
  assert.equal(upload?.form?.get("key"), "uploads/11/aa/22/3:video:fixture");
  assert.equal(upload?.form?.get("x-amz-signature"), "fixture-signature");
  assert.ok(upload?.form?.get("file") instanceof Blob);
  assert.deepEqual(calls[3]?.json, {
    board_id: "549755885175",
    media_source: {
      source_type: "video_id",
      cover_image_url: "https://cdn.example.test/cover.jpg",
      media_id: "12345",
    },
    title: "Clip",
    description: "Watch",
  });
});

test("[feature:pinterest.publish.video] a processing video returns processing; getDelivery stays read-only and continueVideoPin creates the Pin once", async () => {
  const workflowStore = new MemoryPinterestWorkflowStore();

  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [
      json(fixtures.media("processing")),
      json(fixtures.media("succeeded")),
      json(fixtures.media("succeeded")),
    ],
    ["POST " + api + "/v5/pins"]: [json(fixtures.pin, 201)],
  });

  const { social, adapter } = client(fetch, { workflowStore });

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const first = only(result.outcomes);
  assert.equal(first.state, "processing");
  assert.ok(first.delivery);

  // A status read reports a ready upload without writing anything.
  const ready = await social.posts.getDelivery(first.delivery);
  assert.equal(ready.state, "processing");
  assert.equal(ready.backendState, "MEDIA_READY");
  assert.equal(calls.filter((call) => call.url.pathname === "/v5/pins").length, 0);

  const resumed = await adapter.native!.continueVideoPin({ delivery: first.delivery, context });
  assert.equal(resumed.state, "published");
  assert.equal(
    calls.filter((call) => call.method === "POST" && call.url.pathname === "/v5/pins").length,
    1,
  );
  assert.deepEqual(calls.at(-1)?.json?.["media_source"], {
    source_type: "video_id",
    cover_image_url: "https://cdn.example.test/cover.jpg",
    media_id: "12345",
  });

  // A repeated status read answers from the store and sends nothing.
  const again = await social.posts.getDelivery(first.delivery);
  assert.equal(again.state, "published");
  assert.equal(calls.length, 6);
});

test("a concurrent continuation of the same video is not run twice", async () => {
  const workflowStore = new MemoryPinterestWorkflowStore();

  const workflow = await workflowStore.create({
    backend: "default",
    accountId,
    mediaId: "12345",
    pin: {
      board_id: "1",
      media_source: { source_type: "video_id", cover_image_url: "https://cdn.example.test/c.jpg" },
    },
    stage: "processing",
  });

  assert.equal(await workflowStore.claim(workflow.id), true);

  const { adapter } = client(route({}).fetch, { workflowStore });

  const outcome = await adapter.native!.continueVideoPin({
    delivery: {
      kind: "delivery",
      version: 1,
      backend: "default",
      platform: "pinterest",
      accountId,
      deliveryId: workflow.id,
    },
    context,
  });

  assert.equal(outcome.state, "processing");
  assert.equal(outcome.backendState, "CLAIMED");
});

test("a failed media status fails the delivery without creating a Pin", async () => {
  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [json(fixtures.media("failed"))],
  });

  const { social } = client(fetch);

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.equal(outcome.state, "failed");
  assert.ok(outcome.state === "failed");
  assert.equal(outcome.code, "media_error");
  assert.equal(outcome.mediaId, "12345");
  assert.equal(calls.length, 3);
});

test("an S3 rejection fails before any Pin request and keeps the media ID", async () => {
  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response("<Error/>", { status: 403 })],
  });

  const { social } = client(fetch);

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "failed");
  assert.equal(outcome.code, "media_error");
  assert.equal(outcome.mediaId, "12345");
  assert.equal(calls.length, 2);
});

test("an upload URL outside Pinterest's bucket is never contacted", async () => {
  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [
      json({ ...fixtures.mediaRegistration, upload_url: "https://evil.example.test/" }, 201),
    ],
  });

  const { social } = client(fetch);

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  assert.equal(only(result.outcomes).state, "failed");
  assert.equal(calls.length, 1);
});

test("[feature:pinterest.sandbox] the sandbox host takes image Pins and refuses video before any request", async () => {
  const sandboxHost = "api-sandbox.pinterest.com";

  const { fetch, calls } = route({
    ["POST " + sandboxHost + "/v5/pins"]: [json(fixtures.pin, 201)],
  });

  const { social, adapter } = client(fetch, { sandbox: true });

  const image = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [imageUrl] },
  });

  const outcome = only(image.outcomes);
  assert.ok(outcome.state === "published");
  assert.equal(outcome.url, undefined);
  assert.equal(calls[0]?.url.host, sandboxHost);

  const videoIssues = adapter.posts!.prepareTarget({
    targetIndex: 0,
    targetKey: "0",
    account,
    content: { media: [video()] },
    options: { boardId: "1" },
  });

  assert.ok(videoIssues.some((issue) => issue.code === "pinterest.sandbox_video"));
  assert.ok(
    adapter.capabilities.capabilities.some(
      (entry) =>
        entry.operation === "posts.publish" &&
        entry.formats === undefined &&
        entry.availability === "unsupported-by-platform",
    ),
  );
});

test("[feature:pinterest.uncertain] an unanswered or unreadable Pin creation is unknown, never failed", async () => {
  for (const reply of [json(fixtures.error(1, "Internal"), 500), json({ created: true }, 201)]) {
    const { fetch, calls } = route({ ["POST " + api + "/v5/pins"]: [reply] });
    const { social } = client(fetch);

    const result = await social.posts.publish({
      targets: [{ account, options: { boardId: "1" } }],
      content: { media: [imageUrl] },
    });

    const outcome = only(result.outcomes);
    assert.equal(outcome.state, "unknown");
    assert.equal(calls.length, 1);
  }
});

test("[feature:pinterest.uncertain] an unanswered video Pin request returns unknown with its delivery and is never resent", async () => {
  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [json(fixtures.media("succeeded"))],
    ["POST " + api + "/v5/pins"]: [json(fixtures.error(1, "Internal"), 502)],
  });

  const { social } = client(fetch);

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "unknown");
  assert.equal(outcome.reason, "ambiguous-submission");
  assert.equal(outcome.mediaId, "12345");
  assert.ok(outcome.delivery);

  const again = await social.posts.getDelivery(outcome.delivery);
  assert.equal(again.state, "unknown");
  assert.equal(calls.length, 4);
});

test("a continuation that claims a stale snapshot rereads the row and sends nothing", async () => {
  /** Returns the row as first read, once, to model a reader that paused before claiming. */
  class StaleStore extends MemoryPinterestWorkflowStore {
    stale: PinterestVideoWorkflow | undefined;

    override async get(id: string) {
      const snapshot = this.stale;

      if (snapshot !== undefined) {
        this.stale = undefined;

        return snapshot;
      }

      return super.get(id);
    }
  }

  const workflowStore = new StaleStore();

  const workflow = await workflowStore.create({
    backend: "default",
    accountId,
    mediaId: "12345",
    pin: {
      board_id: "1",
      media_source: { source_type: "video_id", cover_image_url: "https://cdn.example.test/c.jpg" },
    },
    stage: "processing",
  });

  workflowStore.stale = workflow;
  await workflowStore.update(workflow.id, { stage: "published", pinId: fixtures.pin.id });

  const { fetch, calls } = route({});
  const { adapter } = client(fetch, { workflowStore });

  const outcome = await adapter.native!.continueVideoPin({
    delivery: {
      kind: "delivery",
      version: 1,
      backend: "default",
      platform: "pinterest",
      accountId,
      deliveryId: workflow.id,
    },
    context,
  });

  assert.ok(outcome.state === "published");
  assert.equal(outcome.post.postId, fixtures.pin.id);
  assert.equal(calls.length, 0);
});

test("[feature:pinterest.errors] permission, reconnect and rate-limit answers map to failed outcomes", async () => {
  const cases = [
    [json(fixtures.error(403, "Forbidden"), 403), "missing_permission", { kind: "never" }],
    [
      json(fixtures.error(2, "Authentication failed."), 401),
      "reconnect_required",
      { kind: "after-reconnect" },
    ],
    [
      json(fixtures.error(8, "Rate limited"), 429, { "retry-after": "30" }),
      "rate_limited",
      { kind: "after-delay", delayMs: 30_000 },
    ],
  ] as const;

  for (const [reply, code, retryDisposition] of cases) {
    const { fetch, calls } = route({ ["POST " + api + "/v5/pins"]: [reply] });
    const { social } = client(fetch);

    const result = await social.posts.publish({
      targets: [{ account, options: { boardId: "1" } }],
      content: { media: [imageUrl] },
    });

    const outcome = only(result.outcomes);
    assert.ok(outcome.state === "failed", code);
    assert.equal(outcome.code, code);
    assert.deepEqual(outcome.retryDisposition, retryDisposition);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(outcome), /fixture-token/);
  }
});

test("one publish keeps per-destination outcomes when one Pinterest account fails", async () => {
  const ok = route({ ["POST " + api + "/v5/pins"]: [json(fixtures.pin, 201)] });

  const denied = route({
    ["POST " + api + "/v5/pins"]: [json(fixtures.error(403, "Forbidden"), 403)],
  });

  const social = createSocial({
    backends: {
      main: pinterest({ auth: { accessToken: "fixture-token", accountId }, fetch: ok.fetch }),
      brand: pinterest({
        auth: { accessToken: "fixture-token", accountId: "42" },
        fetch: denied.fetch,
      }),
    },
  });

  const result = await social.posts.publish({
    targets: [
      { account: { ...account, backend: "main" }, options: { boardId: "1" } },
      {
        account: connectedAccountRef({ backend: "brand", platform: "pinterest", accountId: "42" }),
        options: { boardId: "2" },
      },
    ],
    content: { media: [imageUrl] },
  });

  assert.equal(result.status, "partial");
  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.account.backend + ":" + outcome.state),
    ["main:published", "brand:failed"],
  );
});

test("[feature:pinterest.delete] removeFromPlatform deletes the Pin and accepts 204", async () => {
  const { fetch, calls } = route({
    ["DELETE " + api + "/v5/pins/813744226420795884"]: [new Response(null, { status: 204 })],
  });

  const { social } = client(fetch);

  const ref = platformPostRef({
    backend: "default",
    platform: "pinterest",
    accountId,
    postId: fixtures.pin.id,
  });

  await social.posts.removeFromPlatform(ref);
  assert.equal(calls[0]?.method, "DELETE");

  const missing = route({
    ["DELETE " + api + "/v5/pins/813744226420795884"]: [
      json(fixtures.error(50, "Pin not found."), 404),
    ],
  });

  const error = await client(missing.fetch)
    .social.posts.removeFromPlatform(ref)
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "not_found");

  const foreign = await social.posts
    .removeFromPlatform(
      platformPostRef({ backend: "default", platform: "pinterest", accountId: "9", postId: "1" }),
    )
    .catch((cause: unknown) => cause);

  assert.ok(foreign instanceof SocialError);
  assert.equal(calls.length, 1);
});

test("[feature:pinterest.accounts] accounts.list reads user_account and rejects another user's token", async () => {
  const { fetch } = route({ ["GET " + api + "/v5/user_account"]: [json(fixtures.userAccount)] });
  const page = await client(fetch).social.accounts.list();

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.handle, "fixture_maker");
  assert.equal(page.items[0]?.displayName, "Fixture Studio");
  assert.equal(page.items[0]?.ref.accountId, accountId);

  const other = route({
    ["GET " + api + "/v5/user_account"]: [json({ ...fixtures.userAccount, id: "1" })],
  });

  const error = await client(other.fetch)
    .social.accounts.list()
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "unauthorized");
});

test("[feature:pinterest.boards] native.listBoards pages with bookmark, page_size and privacy", async () => {
  const { fetch, calls } = route({
    ["GET " + api + "/v5/boards"]: [
      json({
        ...fixtures.boardsPage,
        items: [...fixtures.boardsPage.items, { id: "9", name: "Hidden", privacy: "SECRET" }],
      }),
    ],
  });

  const { adapter } = client(fetch);

  const page = await adapter.native!.listBoards({
    account,
    context,
    limit: 100,
    privacy: "PROTECTED",
    cursor: "abc",
  });

  assert.equal(page.nextCursor, "ZmlsdGVyOjE=");
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.["id"], "549755885175");
  assert.deepEqual(page.items[0]?.["owner"], { username: "fixture_maker" });
  assert.equal(calls[0]?.url.searchParams.get("page_size"), "100");
  assert.equal(calls[0]?.url.searchParams.get("privacy"), "PROTECTED");
  assert.equal(calls[0]?.url.searchParams.get("bookmark"), "abc");

  await assert.rejects(adapter.native!.listBoards({ account, context, limit: 251 }), {
    code: "invalid_input",
  });
  await assert.rejects(
    adapter.native!.listBoards({
      account: connectedAccountRef({ backend: "default", platform: "pinterest", accountId: "9" }),
      context,
    }),
    { code: "unauthorized" },
  );
});

test("the adapter rejects missing credentials and non-numeric account IDs", () => {
  assert.throws(() => pinterest({ auth: { accessToken: " ", accountId } }), {
    code: "invalid_config",
  });
  assert.throws(() => pinterest({ auth: { accessToken: "t", accountId: "user" } }), {
    code: "invalid_config",
  });
});

test("a file-backed video Blob reaches S3 byte for byte inside the multipart body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pinterest-video-"));
  const bytes = new Uint8Array(4505).map((_, index) => index % 251);
  const path = join(directory, "clip.mp4");
  await writeFile(path, bytes);
  const blob = await openAsBlob(path, { type: "video/mp4" });

  try {
    const { fetch, calls } = route({
      ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
      ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
      ["GET " + api + "/v5/media/12345"]: [json(fixtures.media("processing"))],
    });

    const { social } = client(fetch);

    const result = await social.posts.publish({
      targets: [{ account, options: { boardId: "1" } }],
      content: { media: [video({ source: { kind: "blob", blob, fingerprint: "file" } })] },
    });

    assert.equal(only(result.outcomes).state, "processing");
    const file = calls[1]?.form?.get("file");
    assert.ok(file instanceof Blob);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
    assert.equal(calls[1]?.headers.get("content-length"), String(calls[1]?.size));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the initial publish rereads its workflow under the claim before creating the Pin", async () => {
  /** Another worker finishes the row between create() and the publishing call's claim. */
  class RacingStore extends MemoryPinterestWorkflowStore {
    override async create(input: Parameters<MemoryPinterestWorkflowStore["create"]>[0]) {
      const row = await super.create(input);
      await this.update(row.id, { stage: "published", pinId: "999" });

      return row;
    }
  }

  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
  });

  const { social } = client(fetch, { workflowStore: new RacingStore() });

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "published");
  assert.equal(outcome.post.postId, "999");
  assert.equal(calls.length, 2);
});

test("a rate-limited video Pin request keeps its delivery and continues later", async () => {
  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [
      json(fixtures.media("succeeded")),
      json(fixtures.media("succeeded")),
    ],
    ["POST " + api + "/v5/pins"]: [
      json(fixtures.error(8, "Rate limited"), 429, { "retry-after": "5" }),
      json(fixtures.pin, 201),
    ],
  });

  const { social, adapter } = client(fetch);

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "failed");
  assert.equal(outcome.code, "rate_limited");
  assert.deepEqual(outcome.retryDisposition, { kind: "reconcile-first" });
  assert.equal(outcome.mediaId, "12345");
  assert.ok(outcome.delivery);

  const resumed = await adapter.native!.continueVideoPin({ delivery: outcome.delivery, context });
  assert.equal(resumed.state, "published");
  assert.equal(calls.filter((call) => call.url.pathname === "/v5/pins").length, 2);
});

test("a failed status read after the upload keeps the delivery and sends no Pin request", async () => {
  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [json(fixtures.error(1, "Internal"), 500)],
  });

  const { social } = client(fetch);

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "failed");
  assert.equal(outcome.mediaId, "12345");
  assert.ok(outcome.delivery);
  assert.equal(calls.length, 3);
});

test("a failed claim release does not hide a created Pin", async () => {
  class SlipperyStore extends MemoryPinterestWorkflowStore {
    override async release(): Promise<void> {
      throw new Error("lock service unavailable");
    }
  }

  const { fetch } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [json(fixtures.media("succeeded"))],
    ["POST " + api + "/v5/pins"]: [json(fixtures.pin, 201)],
  });

  const { social } = client(fetch, { workflowStore: new SlipperyStore() });

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "published");
  assert.equal(outcome.backendState, "CLAIM_RELEASE_FAILED");
  assert.doesNotMatch(JSON.stringify(outcome), /lock service/);
});

test("a 200 delete answer must name the deleted Pin", async () => {
  const ref = platformPostRef({
    backend: "default",
    platform: "pinterest",
    accountId,
    postId: fixtures.pin.id,
  });

  const path = "DELETE " + api + "/v5/pins/813744226420795884";

  await client(route({ [path]: [json(fixtures.pin)] }).fetch).social.posts.removeFromPlatform(ref);

  const error = await client(route({ [path]: [json({ ...fixtures.pin, id: "1" })] }).fetch)
    .social.posts.removeFromPlatform(ref)
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "ambiguous_outcome");
});

test("the default board list drops secret boards", async () => {
  const { fetch, calls } = route({
    ["GET " + api + "/v5/boards"]: [
      json({
        items: [...fixtures.boardsPage.items, { id: "9", name: "Hidden", privacy: "SECRET" }],
      }),
    ],
  });

  const page = await client(fetch).adapter.native!.listBoards({ account, context });

  assert.deepEqual(
    page.items.map((board) => board["id"]),
    ["549755885175"],
  );
  assert.equal(calls[0]?.url.searchParams.get("privacy"), null);
  assert.equal(page.nextCursor, undefined);
});

test("a Pin request cancelled before dispatch leaves the video continuable", async () => {
  const abort = new AbortController();

  /** Cancels the operation while the adapter saves the creating stage, before the Pin request. */
  class AbortingStore extends MemoryPinterestWorkflowStore {
    override async update(
      id: string,
      update: Parameters<MemoryPinterestWorkflowStore["update"]>[1],
    ) {
      if (update.stage === "creating") abort.abort();

      return super.update(id, update);
    }
  }

  const workflowStore = new AbortingStore();

  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [json(fixtures.media("succeeded"))],
  });

  const { adapter } = client(fetch, { workflowStore });

  const outcome = await adapter.posts!.publishTarget(
    {
      targetIndex: 0,
      targetKey: "0",
      account,
      content: { media: [video()] },
      options: { boardId: "1" },
    },
    { ...context, signal: abort.signal },
  );

  assert.ok(outcome.state === "failed");
  assert.equal(outcome.code, "cancelled");
  assert.deepEqual(outcome.retryDisposition, { kind: "reconcile-first" });
  assert.ok(outcome.delivery);
  assert.equal((await workflowStore.get(outcome.delivery.deliveryId))?.stage, "processing");
  assert.equal(calls.filter((call) => call.url.pathname === "/v5/pins").length, 0);
});

test("an empty 200 delete answer is not a confirmed deletion", async () => {
  const ref = platformPostRef({
    backend: "default",
    platform: "pinterest",
    accountId,
    postId: fixtures.pin.id,
  });

  const { fetch } = route({
    ["DELETE " + api + "/v5/pins/813744226420795884"]: [new Response("", { status: 200 })],
  });

  const error = await client(fetch)
    .social.posts.removeFromPlatform(ref)
    .catch((cause: unknown) => cause);

  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "ambiguous_outcome");
});

test("an unreadable media status after the upload keeps the delivery and stays continuable", async () => {
  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [
      new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
      json(fixtures.media("succeeded")),
    ],
    ["POST " + api + "/v5/pins"]: [json(fixtures.pin, 201)],
  });

  const { social, adapter } = client(fetch);

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "failed");
  assert.equal(outcome.code, "upstream_failure");
  assert.equal(outcome.mediaId, "12345");
  assert.deepEqual(outcome.retryDisposition, { kind: "reconcile-first" });
  assert.ok(outcome.delivery);
  assert.equal(calls.filter((call) => call.url.pathname === "/v5/pins").length, 0);

  const resumed = await adapter.native!.continueVideoPin({ delivery: outcome.delivery, context });
  assert.equal(resumed.state, "published");
});

test("a workflow store error after the upload keeps the delivery and sends no Pin request", async () => {
  class FlakyStore extends MemoryPinterestWorkflowStore {
    failed = false;

    override async claim(id: string) {
      if (!this.failed) {
        this.failed = true;
        throw new Error("store unavailable");
      }

      return super.claim(id);
    }
  }

  const workflowStore = new FlakyStore();

  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [json(fixtures.media("succeeded"))],
    ["POST " + api + "/v5/pins"]: [json(fixtures.pin, 201)],
  });

  const { social, adapter } = client(fetch, { workflowStore });

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "failed");
  assert.equal(outcome.mediaId, "12345");
  assert.deepEqual(outcome.retryDisposition, { kind: "reconcile-first" });
  assert.ok(outcome.delivery);
  assert.equal(calls.length, 2);

  const resumed = await adapter.native!.continueVideoPin({ delivery: outcome.delivery, context });
  assert.equal(resumed.state, "published");
});

test("an S3 upload sent without an answer is unknown, keeps its delivery and is checked by status", async () => {
  const routed = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["GET " + api + "/v5/media/12345"]: [json(fixtures.media("succeeded"))],
  });

  let uploaded = 0;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).host !== s3) return routed.fetch(input, init);
    uploaded = (await new Response(init?.body).arrayBuffer()).byteLength;
    throw new TypeError("socket hang up");
  };

  const { social } = client(fetch);

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "unknown");
  assert.equal(outcome.reason, "ambiguous-submission");
  assert.equal(outcome.mediaId, "12345");
  assert.ok(outcome.delivery);
  assert.ok(uploaded > 0);
  assert.equal(routed.calls.length, 1);

  const status = await social.posts.getDelivery(outcome.delivery);
  assert.equal(status.state, "processing");
  assert.equal(status.backendState, "MEDIA_READY");
  assert.equal(routed.calls.filter((call) => call.url.pathname === "/v5/pins").length, 0);
});

test("a reconnect or rate limit on the video Pin request keeps the workflow continuable", async () => {
  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [
      json(fixtures.media("succeeded")),
      json(fixtures.media("succeeded")),
      json(fixtures.media("succeeded")),
    ],
    ["POST " + api + "/v5/pins"]: [
      json(fixtures.error(2, "Authentication failed"), 401),
      json(fixtures.error(8, "Rate limited"), 429, { "retry-after": "5" }),
      json(fixtures.pin, 201),
    ],
  });

  const { social, adapter } = client(fetch);

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "failed");
  assert.equal(outcome.code, "reconnect_required");
  assert.deepEqual(outcome.retryDisposition, { kind: "reconcile-first" });
  assert.ok(outcome.delivery);

  const limited = await adapter.native!.continueVideoPin({ delivery: outcome.delivery, context });
  assert.ok(limited.state === "failed");
  assert.equal(limited.code, "rate_limited");
  assert.deepEqual(limited.retryDisposition, { kind: "after-delay", delayMs: 5000 });

  const resumed = await adapter.native!.continueVideoPin({ delivery: outcome.delivery, context });
  assert.equal(resumed.state, "published");
  assert.equal(calls.filter((call) => call.url.pathname === "/v5/pins").length, 3);
});

test("a sandbox adapter neither reads nor continues video workflows", async () => {
  const workflowStore = new MemoryPinterestWorkflowStore();

  const production = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [json(fixtures.media("processing"))],
  });

  const result = await client(production.fetch, { workflowStore }).social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const delivery = only(result.outcomes).delivery;
  assert.ok(delivery);

  const sandboxed = route({});
  const { adapter, social } = client(sandboxed.fetch, { workflowStore, sandbox: true });

  const continued = await adapter
    .native!.continueVideoPin({ delivery, context })
    .catch((cause: unknown) => cause);

  assert.ok(continued instanceof SocialError);
  assert.equal(continued.code, "unsupported_capability");

  const status = await social.posts.getDelivery(delivery).catch((cause: unknown) => cause);

  assert.ok(status instanceof SocialError);
  assert.equal(status.code, "unsupported_capability");

  assert.equal(sandboxed.calls.length, 0);

  const declared = adapter.capabilities.capabilities.filter(
    (entry) => entry.operation === "posts.status" || entry.operation === "posts.publish.continue",
  );

  assert.deepEqual(
    declared.map((entry) => entry.availability),
    ["unsupported-by-platform", "unsupported-by-platform"],
  );
});

test("the board list keeps only boards marked public or protected", async () => {
  const { fetch } = route({
    ["GET " + api + "/v5/boards"]: [
      json({
        items: [
          ...fixtures.boardsPage.items,
          { id: "10", name: "Unlabeled" },
          { id: "11", name: "Future", privacy: "UNLISTED" },
          { id: "12", name: "Team", privacy: "PROTECTED" },
        ],
      }),
    ],
  });

  const page = await client(fetch).adapter.native!.listBoards({ account, context });

  assert.deepEqual(
    page.items.map((board) => board["id"]),
    ["549755885175", "12"],
  );
});

test("a video upload cancelled before it is sent fails with its delivery and media ID", async () => {
  const controller = new AbortController();

  // The caller cancels while the workflow is being saved, after registration and before S3.
  class CancellingStore extends MemoryPinterestWorkflowStore {
    override async create(input: Omit<PinterestVideoWorkflow, "id">) {
      controller.abort();

      return super.create(input);
    }
  }

  const routed = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
  });

  const { adapter } = client(routed.fetch, { workflowStore: new CancellingStore() });

  const outcome = await adapter.posts!.publishTarget(
    {
      targetIndex: 0,
      targetKey: "0",
      account,
      content: { media: [video()] },
      options: { boardId: "1" },
    },
    { ...context, signal: controller.signal },
  );

  assert.ok(outcome.state === "failed");
  assert.equal(outcome.code, "cancelled");
  assert.equal(outcome.mediaId, "12345");
  assert.ok(outcome.delivery);
  assert.equal(routed.calls.length, 1);
});

test("a 5xx from S3 after the file was sent is unknown and keeps its delivery", async () => {
  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response("busy", { status: 503 })],
  });

  const result = await client(fetch).social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "unknown");
  assert.equal(outcome.mediaId, "12345");
  assert.ok(outcome.delivery);
  assert.equal(calls.length, 2);
});

test("a workflow store that cannot save the video stops before the file is sent", async () => {
  class BrokenStore extends MemoryPinterestWorkflowStore {
    override async create(): Promise<PinterestVideoWorkflow> {
      throw new Error("store unavailable");
    }
  }

  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
  });

  const result = await client(fetch, { workflowStore: new BrokenStore() }).social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "failed");
  assert.deepEqual(outcome.retryDisposition, { kind: "never" });
  assert.equal(outcome.mediaId, "12345");
  assert.equal(calls.length, 1);
});

test("a rejected Pin request whose workflow update fails says so and is never resent", async () => {
  class StickyStore extends MemoryPinterestWorkflowStore {
    override async update(id: string, update: Partial<Omit<PinterestVideoWorkflow, "id">>) {
      if (update.stage === "processing") throw new Error("store unavailable");

      return super.update(id, update);
    }
  }

  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [json(fixtures.media("succeeded"))],
    ["POST " + api + "/v5/pins"]: [json(fixtures.error(8, "Rate limited"), 429)],
  });

  const { social } = client(fetch, { workflowStore: new StickyStore() });

  const result = await social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "failed");
  assert.equal(outcome.code, "rate_limited");
  assert.equal(outcome.backendState, "WORKFLOW_SAVE_FAILED");
  assert.ok(outcome.delivery);

  const later = await social.posts.getDelivery(outcome.delivery);
  assert.equal(later.state, "unknown");
  assert.equal(calls.filter((call) => call.url.pathname === "/v5/pins").length, 1);
});

test("a Pin creation answered with a status other than 200 or 201 is unknown", async () => {
  const { fetch } = route({ ["POST " + api + "/v5/pins"]: [json(fixtures.pin, 202)] });

  const result = await client(fetch).social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [imageUrl] },
  });

  assert.equal(only(result.outcomes).state, "unknown");
});

test("a malformed media status object is unreadable and stays continuable", async () => {
  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [json({ media_id: "12345", status: 17 })],
  });

  const result = await client(fetch).social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "failed");
  assert.equal(outcome.code, "upstream_failure");
  assert.deepEqual(outcome.retryDisposition, { kind: "reconcile-first" });
  assert.equal(calls.length, 3);
});

test("a failed media registration is a failed outcome, since no file or Pin was sent", async () => {
  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.error(1, "Unavailable"), 503)],
  });

  const result = await client(fetch).social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "failed");
  assert.equal(outcome.delivery, undefined);
  assert.equal(calls.length, 1);
});

test("a store that fails both the save and the release after a rejected Pin reports both", async () => {
  class DownStore extends MemoryPinterestWorkflowStore {
    override async update(id: string, update: Partial<Omit<PinterestVideoWorkflow, "id">>) {
      if (update.stage === "processing") throw new Error("store unavailable");

      return super.update(id, update);
    }

    override async release(): Promise<void> {
      throw new Error("store unavailable");
    }
  }

  const { fetch } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [json(fixtures.media("succeeded"))],
    ["POST " + api + "/v5/pins"]: [json(fixtures.error(8, "Rate limited"), 429)],
  });

  const result = await client(fetch, { workflowStore: new DownStore() }).social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "failed");
  assert.equal(outcome.backendState, "WORKFLOW_SAVE_FAILED,CLAIM_RELEASE_FAILED");
  assert.deepEqual(outcome.retryDisposition, { kind: "reconcile-first" });
  assert.ok(outcome.delivery);
});

test("an unusable media registration answer fails without a delivery", async () => {
  const { fetch, calls } = route({
    ["POST " + api + "/v5/media"]: [
      new Response("null", { status: 201, headers: { "content-type": "application/json" } }),
    ],
  });

  const result = await client(fetch).social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "failed");
  assert.deepEqual(outcome.retryDisposition, { kind: "never" });
  assert.equal(outcome.delivery, undefined);
  assert.equal(calls.length, 1);
});

test("a created Pin whose save and release both fail stays published and reports both", async () => {
  class DownStore extends MemoryPinterestWorkflowStore {
    override async update(id: string, update: Partial<Omit<PinterestVideoWorkflow, "id">>) {
      if (update.stage === "published") throw new Error("store unavailable");

      return super.update(id, update);
    }

    override async release(): Promise<void> {
      throw new Error("store unavailable");
    }
  }

  const { fetch } = route({
    ["POST " + api + "/v5/media"]: [json(fixtures.mediaRegistration, 201)],
    ["POST " + s3 + "/"]: [new Response(null, { status: 204 })],
    ["GET " + api + "/v5/media/12345"]: [json(fixtures.media("succeeded"))],
    ["POST " + api + "/v5/pins"]: [json(fixtures.pin, 201)],
  });

  const result = await client(fetch, { workflowStore: new DownStore() }).social.posts.publish({
    targets: [{ account, options: { boardId: "1" } }],
    content: { media: [video()] },
  });

  const outcome = only(result.outcomes);
  assert.ok(outcome.state === "published");
  assert.equal(outcome.post.postId, fixtures.pin.id);
  assert.equal(outcome.backendState, "CREATED_WORKFLOW_SAVE_FAILED,CLAIM_RELEASE_FAILED");
});

test("board owners are kept so group boards owned by someone else can be told apart", async () => {
  const { fetch } = route({
    ["GET " + api + "/v5/boards"]: [
      json({
        items: [
          ...fixtures.boardsPage.items,
          {
            id: "13",
            name: "Shared recipes",
            privacy: "PUBLIC",
            collaborator_count: 2,
            owner: { username: "another_maker" },
          },
          { id: "14", name: "Odd owner", privacy: "PUBLIC", owner: { username: 7 } },
        ],
      }),
    ],
  });

  const page = await client(fetch).adapter.native!.listBoards({ account, context });

  assert.deepEqual(
    page.items.map((board) => [board["id"], board["owner"]]),
    [
      ["549755885175", { username: "fixture_maker" }],
      ["13", { username: "another_maker" }],
      ["14", undefined],
    ],
  );
});

test("base64 images over the aggregate limit are refused before any Blob is read", async () => {
  let reads = 0;

  class CountingBlob extends Blob {
    override async arrayBuffer(): Promise<ArrayBuffer> {
      reads++;

      return super.arrayBuffer();
    }
  }

  const image = (fingerprint: string) => ({
    kind: "image" as const,
    source: {
      kind: "blob" as const,
      blob: new CountingBlob([new Uint8Array(2)], { type: "image/png" }),
      fingerprint,
    },
  });

  const { fetch, calls } = route({});
  const { adapter, social } = client(fetch, { imageBase64: true, maxBase64Bytes: 3 });

  const issues = adapter
    .posts!.prepareTarget({
      targetIndex: 0,
      targetKey: "0",
      account,
      content: { media: [image("a"), image("b")] },
      options: { boardId: "1" },
    })
    .map((issue) => issue.code);

  assert.deepEqual(issues, ["pinterest.image_size"]);

  await assert.rejects(
    social.posts.publish({
      targets: [{ account, options: { boardId: "1" } }],
      content: { media: [image("c"), image("d")] },
    }),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
  assert.equal(reads, 0);
  assert.equal(calls.length, 0);
});

test("the in-memory workflow store caps admissions and expires only settled workflows", async () => {
  let time = 0;

  const workflowStore = new MemoryPinterestWorkflowStore({
    maxWorkflows: 2,
    retentionMs: 1000,
    now: () => time,
  });

  const row = (stage: "processing" | "creating") => ({
    backend: "default",
    accountId,
    mediaId: "12345",
    pin: { board_id: "1" },
    stage,
  });

  const done = await workflowStore.create(row("processing"));
  const pending = await workflowStore.create(row("creating"));

  await assert.rejects(workflowStore.create(row("processing")));

  await workflowStore.update(done.id, { stage: "published", pinId: "1" });
  time = 999;
  await assert.rejects(workflowStore.create(row("processing")));
  assert.equal((await workflowStore.get(done.id))?.stage, "published");

  time = 1000;
  const next = await workflowStore.create(row("processing"));

  assert.equal(await workflowStore.get(done.id), undefined);
  assert.equal((await workflowStore.get(pending.id))?.stage, "creating");

  time = 1_000_000;
  await assert.rejects(workflowStore.create(row("processing")));
  assert.equal((await workflowStore.get(pending.id))?.stage, "creating");
  assert.equal((await workflowStore.get(next.id))?.stage, "processing");
});

test("settled workflows expire on lookup, and a published row without a Pin ID is kept", async () => {
  let time = 0;
  const workflowStore = new MemoryPinterestWorkflowStore({ retentionMs: 10, now: () => time });

  const row = {
    backend: "default",
    accountId,
    mediaId: "12345",
    pin: { board_id: "1" },
    stage: "processing" as const,
  };

  const confirmed = await workflowStore.create(row);
  const unconfirmed = await workflowStore.create(row);
  const claimed = await workflowStore.create(row);

  await workflowStore.update(confirmed.id, { stage: "published", pinId: "1" });
  await workflowStore.update(unconfirmed.id, { stage: "published" });
  await workflowStore.update(claimed.id, { stage: "failed" });
  assert.equal(await workflowStore.claim(claimed.id), true);

  time = 10;
  assert.equal(await workflowStore.get(confirmed.id), undefined);
  assert.equal((await workflowStore.get(unconfirmed.id))?.stage, "published");
  assert.equal((await workflowStore.get(claimed.id))?.stage, "failed");
});

test("memory limits must be safe integers in range", () => {
  for (const options of [
    { maxWorkflows: Number.NaN },
    { maxWorkflows: Number.POSITIVE_INFINITY },
    { maxWorkflows: 0 },
    { retentionMs: -1 },
    { retentionMs: 1.5 },
  ])
    assert.throws(
      () => new MemoryPinterestWorkflowStore(options),
      (error) => error instanceof SocialError && error.code === "invalid_config",
    );

  for (const maxBase64Bytes of [Number.NaN, Number.POSITIVE_INFINITY, 0])
    assert.throws(
      () => client(route({}).fetch, { imageBase64: true, maxBase64Bytes }),
      (error) => error instanceof SocialError && error.code === "invalid_config",
    );
});
