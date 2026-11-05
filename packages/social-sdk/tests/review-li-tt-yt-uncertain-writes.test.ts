import assert from "node:assert/strict";
import { it } from "node:test";
import { connectedAccountRef, SocialError } from "../src/index.js";
import { linkedin } from "../src/platforms/linkedin.js";
import { tiktok } from "../src/platforms/tiktok.js";
import { youtube } from "../src/platforms/youtube.js";

const context = (maxElapsedMs = 1000) => ({
  backendInstance: "default",
  correlationId: "review-uncertain-writes",
  retryBudget: { maxAttempts: 1, maxElapsedMs },
});

const uncertain = (error: SocialError) =>
  error instanceof SocialError &&
  error.code === "ambiguous_outcome" &&
  error.retryDisposition.kind === "reconcile-first";

const linkedInMember = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: "urn:li:person:member1",
});

const linkedInOrganization = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: "urn:li:organization:12345",
});

const tiktokAccount = connectedAccountRef({
  backend: "default",
  platform: "tiktok",
  accountId: "creator1",
});

function linkedInNative(
  author: Parameters<typeof linkedin>[0]["auth"]["author"],
  respond: () => Response | Promise<Response>,
) {
  const calls: string[] = [];

  const native = linkedin({
    auth: { accessToken: "fixture", author },
    apiVersion: "202610",
    fetch: async (_input, init) => {
      calls.push(init?.method ?? "GET");

      return respond();
    },
  }).native;

  assert.ok(native);

  return { native, calls };
}

it("LinkedIn deleteReaction keeps a lost or 5xx DELETE uncertain and sends it once", async () => {
  // https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/reactions-api
  // documents DELETE /rest/reactions/(actor,entity) with a 204 success response.
  for (const respond of [
    () => Promise.reject(new TypeError("connection lost")),
    () => new Response("", { status: 503 }),
  ]) {
    const { native, calls } = linkedInNative("urn:li:person:member1", respond);

    await assert.rejects(
      native.deleteReaction({
        account: linkedInMember,
        entity: "urn:li:share:123",
        context: context(),
      }),
      uncertain,
    );
    assert.deepEqual(calls, ["DELETE"]);
  }
});

it("LinkedIn notification unsubscribe keeps a lost DELETE uncertain", async () => {
  const { native, calls } = linkedInNative("urn:li:organization:12345", () =>
    Promise.reject(new TypeError("connection lost")),
  );

  await assert.rejects(
    native.unsubscribeOrganizationNotifications({
      account: linkedInOrganization,
      developerApplication: "urn:li:developerApplication:777",
      member: "urn:li:person:abCdef",
      context: context(),
    }),
    uncertain,
  );
  assert.deepEqual(calls, ["DELETE"]);
});

it("LinkedIn DELETE rejections stay definitive", async () => {
  const { native } = linkedInNative(
    "urn:li:person:member1",
    () => new Response("", { status: 404 }),
  );

  await assert.rejects(
    native.deleteReaction({
      account: linkedInMember,
      entity: "urn:li:share:123",
      context: context(),
    }),
    (error: SocialError) =>
      error instanceof SocialError &&
      error.code === "not_found" &&
      error.retryDisposition.kind === "never",
  );
});

it("YouTube live chat bounds a stalled HTTP error body and keeps the HTTP rejection", async () => {
  let cancelled = false;

  const native = youtube({
    auth: { accessToken: "fixture", channelId: "channel1" },
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          // Headers arrive; the error body never does.
          cancel: () => {
            cancelled = true;
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
  }).native;

  assert.ok(native);

  const started = performance.now();

  await assert.rejects(
    native
      .liveChatStream({ liveChatId: "chat1", stallTimeoutMs: 20, context: context(5000) })
      .next(),
    (error: SocialError) =>
      error instanceof SocialError &&
      error.code === "missing_permission" &&
      error.upstreamStatus === 403,
  );
  assert.ok(performance.now() - started < 2000);
  assert.equal(cancelled, true);
});

it("YouTube live chat bounds a stalled error body by the operation budget without a stall timeout", async () => {
  const native = youtube({
    auth: { accessToken: "fixture", channelId: "channel1" },
    fetch: async () =>
      new Response(new ReadableStream<Uint8Array>(), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
  }).native;

  assert.ok(native);

  await assert.rejects(
    native.liveChatStream({ liveChatId: "chat1", context: context(50) }).next(),
    (error: SocialError) =>
      error instanceof SocialError && error.code === "rate_limited" && error.upstreamStatus === 429,
  );
});

it("YouTube live chat still reads error reasons from a complete error body", async () => {
  const native = youtube({
    auth: { accessToken: "fixture", channelId: "channel1" },
    fetch: async () =>
      Response.json(
        { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } },
        { status: 403 },
      ),
  }).native;

  assert.ok(native);

  await assert.rejects(
    native.liveChatStream({ liveChatId: "chat1", stallTimeoutMs: 1000, context: context() }).next(),
    (error: SocialError) => error instanceof SocialError && error.code === "rate_limited",
  );
});

function tiktokNative(respond: () => Response) {
  let calls = 0;

  const native = tiktok({
    auth: { accessToken: "fixture", openId: tiktokAccount.accountId },
    verifiedMediaOrigins: [],
    fetch: async () => {
      calls += 1;

      return respond();
    },
  }).native;

  assert.ok(native);

  return { native, calls: () => calls };
}

it("TikTok addDataRequest treats an unusable accepted response as uncertain", async () => {
  // https://developers.tiktok.com/doc/data-portability-api-add-data-request: a .single scope
  // allows one request, so a lost request_id must not look like a failed create.
  for (const body of [
    { data: {}, error: { code: "ok" } },
    { data: [], error: { code: "ok" } },
    { error: { code: "ok" } },
    [],
  ]) {
    const { native, calls } = tiktokNative(() => Response.json(body));

    await assert.rejects(
      native.addDataRequest({
        account: tiktokAccount,
        dataFormat: "json",
        categories: ["profile"],
        context: context(),
      }),
      uncertain,
    );
    assert.equal(calls(), 1);
  }

  // An int64 ID beyond Number.MAX_SAFE_INTEGER cannot be sent back to TikTok exactly.
  const unsafe = tiktokNative(
    () =>
      new Response('{"data":{"request_id":9007199254740993},"error":{"code":"ok"}}', {
        headers: { "content-type": "application/json" },
      }),
  );

  await assert.rejects(
    unsafe.native.addDataRequest({
      account: tiktokAccount,
      dataFormat: "json",
      categories: ["profile"],
      context: context(),
    }),
    uncertain,
  );
});

it("TikTok addDataRequest keeps explicit rejections definitive and valid IDs intact", async () => {
  const rejected = tiktokNative(() =>
    Response.json({ data: {}, error: { code: "scope_not_authorized", message: "no" } }),
  );

  await assert.rejects(
    rejected.native.addDataRequest({
      account: tiktokAccount,
      dataFormat: "json",
      categories: ["profile"],
      context: context(),
    }),
    (error: SocialError) =>
      error instanceof SocialError &&
      error.code === "missing_permission" &&
      error.retryDisposition.kind === "never",
  );

  const accepted = tiktokNative(() =>
    Response.json({ data: { request_id: 123451234512345 }, error: { code: "ok" } }),
  );

  assert.deepEqual(
    await accepted.native.addDataRequest({
      account: tiktokAccount,
      dataFormat: "json",
      categories: ["profile"],
      context: context(),
    }),
    { requestId: "123451234512345" },
  );
});

function youtubeNative(respond: (url: URL, method: string) => Response) {
  const calls: string[] = [];

  const native = youtube({
    auth: { accessToken: "fixture", channelId: "channel1" },
    fetch: async (input, init) => {
      const method = init?.method ?? "GET";

      calls.push(method);

      return respond(new URL(String(input)), method);
    },
  }).native;

  assert.ok(native);

  return { native, calls };
}

it("YouTube native writes treat an invalid success payload as uncertain", async () => {
  // https://developers.google.com/youtube/analytics/reference/groups/insert returns a group
  // resource; https://developers.google.com/youtube/reporting/v1/reference/rest/v1/jobs/create
  // returns a job.
  const { native, calls } = youtubeNative(() => Response.json([]));

  await assert.rejects(
    native.analyticsGroups({
      action: "insert",
      title: "Review group",
      itemType: "youtube#video",
      context: context(),
    }),
    uncertain,
  );
  await assert.rejects(
    native.analyticsGroupItems({
      action: "insert",
      groupId: "group1",
      resource: { kind: "youtube#video", id: "video1" },
      context: context(),
    }),
    uncertain,
  );
  await assert.rejects(
    native.reportingJobs({
      action: "create",
      reportTypeId: "channel_basic_a2",
      name: "Daily basics",
      context: context(),
    }),
    uncertain,
  );
  await assert.rejects(
    native.playlists({
      action: "insert",
      body: { snippet: { title: "Review" } },
      context: context(),
    }),
    uncertain,
  );
  assert.deepEqual(calls, ["POST", "POST", "POST", "POST"]);
});

it("YouTube binary uploads treat an unusable success payload as uncertain", async () => {
  const banner = () =>
    ({
      image: {
        kind: "image",
        mimeType: "image/png",
        source: { kind: "blob", blob: new Blob([new Uint8Array(8)]), fingerprint: "banner" },
      },
      context: context(),
    }) satisfies Parameters<
      NonNullable<ReturnType<typeof youtube>["native"]>["uploadChannelBanner"]
    >[0];

  const missingUrl = youtubeNative(() => Response.json({ kind: "youtube#channelBannerResource" }));

  await assert.rejects(missingUrl.native.uploadChannelBanner(banner()), uncertain);

  const notObject = youtubeNative(() => Response.json("done"));

  await assert.rejects(notObject.native.uploadChannelBanner(banner()), uncertain);
});

it("YouTube reads that share a write method keep definitive decode failures", async () => {
  const { native, calls } = youtubeNative(() => Response.json([]));

  await assert.rejects(
    native.playlists({ action: "list", context: context() }),
    (error: Error) => !(error instanceof SocialError && error.code === "ambiguous_outcome"),
  );
  assert.deepEqual(calls, ["GET"]);
});
