/**
 * Every TikTok write is confirmed only by its documented success answer. Each row sends one
 * write and gets one answer: the documented one resolves, and every malformed one (a JSON
 * `null`, an array, an empty envelope, a missing or malformed `error.code`, or a missing or
 * wrong-type `publish_id`) is `ambiguous_outcome` with `reconcile-first`. Stated rejections keep
 * their classification, and no error carries TikTok's prose or URLs. Chunk uploads must answer
 * 206 before the last chunk and 201 on it. The sweep behind this table is in the SOC-37 notes.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { SocialError, connectedAccountRef, createSocial } from "../src/index.js";
import type { AdapterOperationContext, JsonValue, PublishRequest } from "../src/core/types.js";
import { tiktok, type TikTokNative } from "../src/platforms/tiktok.js";
import { planTikTokChunks, transferTikTokVideo } from "../src/platforms/tiktok-upload.js";

const account = connectedAccountRef({ backend: "default", platform: "tiktok", accountId: "c1" });

const context = (): AdapterOperationContext => ({
  backendInstance: "default",
  correlationId: "write-confirmation",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
});

function uncertain(error: SocialError): boolean {
  return (
    error instanceof SocialError &&
    error.code === "ambiguous_outcome" &&
    error.retryDisposition.kind === "reconcile-first"
  );
}

/** The `SocialError` a write rejected with; any other result fails the test. */
async function rejection(sent: Promise<object | void>): Promise<SocialError> {
  try {
    await sent;
  } catch (error) {
    if (error instanceof SocialError) return error;

    throw error;
  }

  return assert.fail("expected a rejection");
}

const leak = "private-marker https://cdn.example.test/v.mp4?signature=fixture";

/** Success-status answers that do not carry the documented `ok` envelope. */
const notOkEnvelopes: readonly (readonly [string, JsonValue])[] = [
  ["JSON null", null],
  ["array", []],
  ["empty object", {}],
  ["error is null", { error: null }],
  ["error without code", { error: {} }],
  ["numeric code", { error: { code: 7 } }],
  ["empty code", { error: { code: "" } }],
];

/** `ok` envelopes whose `data.publish_id` is missing or unusable. */
const badPublishIds: readonly (readonly [string, JsonValue])[] = [
  ...notOkEnvelopes,
  ["no data", { error: { code: "ok" } }],
  ["data is an array", { data: [], error: { code: "ok" } }],
  ["no publish_id", { data: {}, error: { code: "ok" } }],
  ["numeric publish_id", { data: { publish_id: 99 }, error: { code: "ok" } }],
  ["blank publish_id", { data: { publish_id: "  " }, error: { code: "ok" } }],
];

/** TikTok's native methods over a fake fetch that records each path and gives `answer`. */
function adapter(answer: () => Response, calls: string[]) {
  const created = tiktok({
    auth: { accessToken: "fixture-token", openId: "c1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async (input) => {
      calls.push(new URL(String(input)).pathname);

      return answer();
    },
  });

  assert.ok(created.native);

  const native: TikTokNative = created.native;

  return { native };
}

interface Write {
  readonly name: string;
  readonly path: string;
  readonly malformed: readonly (readonly [string, JsonValue])[];
  readonly valid: JsonValue;
  readonly send: (native: ReturnType<typeof adapter>["native"]) => Promise<object | void>;
}

const writes: readonly Write[] = [
  {
    name: "cancelPublish",
    path: "/v2/post/publish/cancel/",
    malformed: notOkEnvelopes,
    valid: { error: { code: "ok", message: "", log_id: "l1" } },
    send: (native) => native.cancelPublish({ account, publishId: "p1", context: context() }),
  },
  {
    name: "cancelDataRequest",
    path: "/v2/user/data/cancel/",
    malformed: notOkEnvelopes,
    valid: { error: { code: "ok", message: "", log_id: "l1" } },
    send: (native) => native.cancelDataRequest({ account, requestId: "123", context: context() }),
  },
  {
    name: "uploadDraft (PULL_FROM_URL)",
    path: "/v2/post/publish/inbox/video/init/",
    malformed: badPublishIds,
    valid: { data: { publish_id: "v_inbox_url~v2.1" }, error: { code: "ok" } },
    send: (native) =>
      native.uploadDraft({
        account,
        video: {
          source_info: { source: "PULL_FROM_URL", video_url: "https://media.example.test/v.mp4" },
        },
        context: context(),
      }),
  },
  {
    name: "uploadDraft (FILE_UPLOAD)",
    path: "/v2/post/publish/inbox/video/init/",
    malformed: [
      ...badPublishIds,
      ["no upload_url", { data: { publish_id: "v1" }, error: { code: "ok" } }],
      ["numeric upload_url", { data: { publish_id: "v1", upload_url: 1 }, error: { code: "ok" } }],
    ],
    valid: {
      data: { publish_id: "v1", upload_url: "https://open-upload.tiktokapis.com/video/?x=1" },
      error: { code: "ok" },
    },
    send: (native) =>
      native.uploadDraft({
        account,
        video: {
          source_info: {
            source: "FILE_UPLOAD",
            video_size: 1,
            chunk_size: 1,
            total_chunk_count: 1,
          },
        },
        context: context(),
      }),
  },
];

for (const write of writes) {
  for (const [name, body] of write.malformed)
    it(`TikTok ${write.name}: ${name} is an unconfirmed write`, async () => {
      const calls: string[] = [];

      await assert.rejects(write.send(adapter(() => Response.json(body), calls).native), uncertain);
      assert.deepEqual(calls, [write.path]);
    });

  it(`TikTok ${write.name}: the documented answer resolves`, async () => {
    const calls: string[] = [];
    await write.send(adapter(() => Response.json(write.valid), calls).native);
    assert.deepEqual(calls, [write.path]);
  });

  it(`TikTok ${write.name}: a stated rejection stays definite and carries no provider prose`, async () => {
    const calls: string[] = [];

    const error = await rejection(
      write.send(
        adapter(
          () =>
            Response.json(
              { error: { code: "invalid_params", message: leak, log_id: "l1" } },
              { status: 400 },
            ),
          calls,
        ).native,
      ),
    );

    assert.equal(error.code, "upstream_failure");
    assert.equal(error.upstreamCode, "invalid_params");
    assert.equal(error.retryDisposition.kind, "never");
    assert.doesNotMatch(JSON.stringify(error.toJSON()), /private-marker|signature|cdn\.example/);
    assert.doesNotMatch(error.message, /private-marker|https:/);
    assert.deepEqual(calls, [write.path]);
  });
}

it("TikTok keeps only machine error codes, never prose in the code field", async () => {
  const calls: string[] = [];

  const error = await rejection(
    adapter(
      () => Response.json({ error: { code: leak } }, { status: 400 }),
      calls,
    ).native.cancelPublish({ account, publishId: "p1", context: context() }),
  );

  assert.equal(error.upstreamCode, undefined);
  assert.doesNotMatch(JSON.stringify(error.toJSON()), /private-marker|signature/);
  assert.equal(calls.length, 1);
});

it("TikTok never reads an HTTP error answer with an ok envelope as success", async () => {
  const calls: string[] = [];

  const error = await rejection(
    adapter(
      () => Response.json({ error: { code: "ok" } }, { status: 400 }),
      calls,
    ).native.cancelPublish({ account, publishId: "p1", context: context() }),
  );

  assert.notEqual(error.code, "ambiguous_outcome");
  assert.equal(calls.length, 1);
});

const publishRequest: PublishRequest = {
  targets: [
    {
      account,
      options: {
        privacy: "SELF_ONLY",
        consentGiven: true,
        disableComments: true,
        disableDuet: true,
        disableStitch: true,
        brandedContent: false,
        ownBrand: false,
        aiGenerated: false,
        draft: false,
        creatorInfo: {
          accountId: "c1",
          backend: "default",
          username: "demo",
          nickname: "Demo",
          fetchedAt: "2026-11-05T00:00:00Z",
          privacyLevels: ["SELF_ONLY"],
          commentDisabled: false,
          duetDisabled: false,
          stitchDisabled: false,
          maxVideoDurationSeconds: 60,
        },
      },
    },
  ],
  content: {
    text: "caption",
    media: [
      {
        kind: "video",
        mimeType: "video/mp4",
        durationSeconds: 30,
        source: { kind: "https-url", url: "https://media.example.test/video.mp4" },
      },
    ],
  },
};

const creatorInfo = {
  data: {
    creator_username: "demo",
    creator_nickname: "Demo",
    privacy_level_options: ["SELF_ONLY"],
    comment_disabled: false,
    duet_disabled: false,
    stitch_disabled: false,
    max_video_post_duration_sec: 60,
  },
  error: { code: "ok" },
};

for (const [name, body] of [
  ...badPublishIds,
  ["valid", { data: { publish_id: "p1" }, error: { code: "ok" } }],
] as const)
  it(`TikTok posts.publish video init: ${name}`, async () => {
    const calls: string[] = [];

    const tiktokAdapter = tiktok({
      auth: { accessToken: "fixture-token", openId: "c1" },
      verifiedMediaOrigins: ["https://media.example.test"],
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        calls.push(path);

        return Response.json(path.includes("creator_info") ? creatorInfo : body);
      },
    });

    const result = await createSocial({ backend: tiktokAdapter }).posts.publish(publishRequest);
    const outcome = result.outcomes[0];

    assert.deepEqual(
      calls.filter((path) => path === "/v2/post/publish/video/init/"),
      ["/v2/post/publish/video/init/"],
    );

    if (name === "valid") {
      assert.equal(outcome?.state, "accepted");
      assert.equal(outcome?.delivery?.deliveryId, "p1");
    } else {
      assert.equal(outcome?.state, "unknown");
      assert.equal(
        outcome?.state === "unknown" ? outcome.reason : undefined,
        "ambiguous-submission",
      );
    }
  });

const MiB = 1024 * 1024;

async function transfer(status: (final: boolean) => number) {
  const plan = planTikTokChunks(10 * MiB, 5 * MiB);
  assert.ok(plan !== undefined && plan.totalChunkCount === 2);
  const puts: string[] = [];

  const result = await transferTikTokVideo({
    uploadUrl: new URL("https://open-upload.tiktokapis.com/video/?upload_id=1"),
    video: {
      plan,
      mimeType: "video/mp4",
      source: { kind: "blob", blob: new Blob([new Uint8Array(10 * MiB)]), fingerprint: "v" },
    },
    fetch: async (_input, init) => {
      const range = new Headers(init?.headers).get("content-range") ?? "";
      puts.push(range);

      return new Response(null, { status: status(range.endsWith(`-${10 * MiB - 1}/${10 * MiB}`)) });
    },
    signal: undefined,
    timeoutMs: 5000,
  });

  return { result, puts };
}

it("TikTok chunk upload completes only on 206 then 201", async () => {
  const { result, puts } = await transfer((final) => (final ? 201 : 206));
  assert.equal(result.kind, "complete");
  assert.equal(puts.length, 2);
});

for (const status of [200, 202, 204, 206])
  it(`TikTok final chunk answered ${status} is uncertain, not complete`, async () => {
    const { result, puts } = await transfer((final) => (final ? status : 206));
    assert.equal(result.kind, "uncertain");
    assert.equal(puts.length, 2);
  });

for (const status of [200, 201, 204])
  it(`TikTok non-final chunk answered ${status} stops before the final chunk`, async () => {
    const { result, puts } = await transfer((final) => (final ? 201 : status));
    assert.equal(result.kind, "failed");
    assert.equal(puts.length, 1);
  });
