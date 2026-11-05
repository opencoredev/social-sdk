import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, createSocial } from "../src/index.js";
import { postiz } from "../src/cloud/postiz.js";
import { SocialError } from "../src/core/errors.js";
import type {
  AdapterOperationContext,
  BackendPostRef,
  DeliveryRef,
  JsonObject,
  JsonValue,
} from "../src/core/types.js";
import { isJsonValue } from "../src/transport/json.js";
import { isJsonObject, string } from "../src/transport/validation.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-09-24T12:00:00.000Z");

const future = "2026-09-25T09:00:00.000Z";

const x = connectedAccountRef({ backend: "default", platform: "x", accountId: "int1" });

const delivery: DeliveryRef = {
  kind: "delivery",
  version: 1,
  backend: "default",
  platform: "x",
  accountId: "int1",
  deliveryId: `p1@${future}`,
};

const row = (fields: JsonObject): JsonObject => ({
  id: "p1",
  content: "hello",
  publishDate: future,
  releaseURL: null,
  releaseId: null,
  state: "QUEUE",
  group: "5e1f0c3a-8b2d-4f6e-9a7c-1d3b5f7e9a20",
  integration: { id: "int1", providerIdentifier: "x", name: "Demo" },
  ...fields,
});

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly body: JsonValue | FormData | undefined;
}

/** A fake Postiz that answers each `METHOD /path` from `routes` and records every request. */
function fakePostiz(routes: Record<string, (call: Call) => JsonValue>) {
  const calls: Call[] = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const raw = init?.body;
    let body: JsonValue | FormData | undefined;

    if (raw instanceof FormData) body = raw;
    else if (raw !== undefined && raw !== null) {
      const parsed: unknown = JSON.parse(String(raw));

      assert.ok(isJsonValue(parsed));
      body = parsed;
    }

    const call = { method, url, body };

    calls.push(call);

    const route = routes[`${method} ${url.pathname}`];

    if (!route) return Response.json({ msg: "not found" }, { status: 404 });

    return Response.json(route(call));
  };

  return { calls, fetch };
}

it("Postiz reads the workspace, the connection, and customer groups", async () => {
  const { calls, fetch } = fakePostiz({
    "GET /public/v1/me": () => ({
      organization: { id: "org1", name: "My Company" },
      user: { id: "u1", name: "Ada", picture: "https://uploads.postiz.com/a.jpg" },
    }),
    "GET /public/v1/is-connected": () => ({ connected: true }),
    "GET /public/v1/groups": () => [{ id: "customer1", name: "Client A" }],
    "GET /public/v1/integrations": () => [
      { id: "int1", name: "Demo", identifier: "x", profile: "demo", disabled: false },
    ],
  });

  const adapter = postiz({ apiKey: "test", clock, fetch, group: "customer1" });

  assert.deepEqual(await adapter.native.me(context), {
    organization: { id: "org1", name: "My Company" },
    user: { id: "u1", name: "Ada", picture: "https://uploads.postiz.com/a.jpg" },
  });
  assert.equal(await adapter.native.isConnected(context), true);
  assert.deepEqual(await adapter.native.listGroups(context), [
    { id: "customer1", name: "Client A" },
  ]);

  const accounts = await adapter.accounts.list({}, context);

  assert.deepEqual(
    accounts.items.map((item) => item.ref.accountId),
    ["int1"],
  );

  const integrations = calls.find((call) => call.url.pathname === "/public/v1/integrations");

  assert.equal(integrations?.url.searchParams.get("group"), "customer1");

  const apiKeyOnly = fakePostiz({
    "GET /public/v1/me": () => ({ organization: { id: "org1" }, user: null }),
  });

  assert.deepEqual(await postiz({ apiKey: "test", fetch: apiKeyOnly.fetch }).native.me(context), {
    organization: { id: "org1" },
  });

  assert.throws(
    () => postiz({ apiKey: "test", fetch, group: "../other" }),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Postiz creates connect links for Pinterest, Reddit, Google Business, Discord, and Twitch", async () => {
  const { calls, fetch } = fakePostiz({
    "GET /public/v1/social/pinterest": () => ({ url: "https://www.pinterest.com/oauth/?s=1" }),
    "GET /public/v1/social/gmb": () => ({ url: "https://accounts.google.com/o/oauth2?s=1" }),
  });

  const adapter = postiz({ apiKey: "test", fetch });

  assert.deepEqual(await adapter.native.createConnectLink({ provider: "pinterest" }, context), {
    url: "https://www.pinterest.com/oauth/?s=1",
  });
  assert.deepEqual(await adapter.native.createConnectLink({ provider: "gmb" }, context), {
    url: "https://accounts.google.com/o/oauth2?s=1",
  });
  assert.deepEqual(
    calls.map((call) => call.url.pathname),
    ["/public/v1/social/pinterest", "/public/v1/social/gmb"],
  );

  await assert.rejects(
    adapter.native.createConnectLink({ provider: "mastodon" }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Postiz deletes a channel only after the same ID confirms it", async () => {
  const { calls, fetch } = fakePostiz({
    "DELETE /public/v1/integrations/int1": () => ({ id: "int1" }),
    "DELETE /public/v1/integrations/int2": () => ({}),
  });

  const adapter = postiz({ apiKey: "test", fetch });

  await assert.rejects(
    adapter.native.deleteChannel(x, { confirmAccountId: "int9" }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
  assert.equal(calls.length, 0);

  await adapter.native.deleteChannel(x, { confirmAccountId: "int1" }, context);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url.pathname}`),
    ["DELETE /public/v1/integrations/int1"],
  );

  const other = connectedAccountRef({ backend: "default", platform: "x", accountId: "int2" });

  await assert.rejects(
    adapter.native.deleteChannel(other, { confirmAccountId: "int2" }, context),
    (error) => error instanceof SocialError && error.code === "ambiguous_outcome",
  );
});

it("Postiz reads channel settings, runs a provider tool, and finds a free slot", async () => {
  const { calls, fetch } = fakePostiz({
    "GET /public/v1/integration-settings/int1": () => ({
      output: {
        rules: "One attachment for a story",
        maxLength: 2200,
        settings: { type: "object" },
        tools: [
          {
            methodName: "audioSearch",
            description: "Search audio",
            dataSchema: [{ key: "q", type: "string" }],
          },
        ],
      },
    }),
    "POST /public/v1/integration-trigger/int1": () => ({ output: [{ id: "587784541076604" }] }),
    "GET /public/v1/find-slot/int1": () => ({ date: "2025-01-15T10:00:00.000Z" }),
  });

  const adapter = postiz({ apiKey: "test", fetch });

  assert.deepEqual(await adapter.native.getChannelSettings(x, context), {
    rules: "One attachment for a story",
    maxLength: 2200,
    settings: { type: "object" },
    tools: [
      {
        methodName: "audioSearch",
        description: "Search audio",
        dataSchema: [{ key: "q", type: "string" }],
      },
    ],
  });

  assert.deepEqual(
    await adapter.native.triggerTool(
      x,
      { methodName: "audioSearch", data: { q: "summer vibes", type: "music" } },
      context,
    ),
    [{ id: "587784541076604" }],
  );
  assert.deepEqual(
    calls.find((call) => call.url.pathname === "/public/v1/integration-trigger/int1")?.body,
    { methodName: "audioSearch", data: { q: "summer vibes", type: "music" } },
  );

  await assert.rejects(
    adapter.native.triggerTool(x, { methodName: "../delete" }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );

  assert.deepEqual(await adapter.native.findSlot(x, context), {
    at: "2025-01-15T10:00:00.000Z",
  });
  assert.equal(calls.at(-1)?.url.pathname, "/public/v1/find-slot/int1");
});

it("Postiz lists the media library and uploads with adjust when asked", async () => {
  let status = "processing";

  const { calls, fetch } = fakePostiz({
    "GET /public/v1/media": () => ({
      pages: 3,
      results: [
        {
          id: "m1",
          name: "a.png",
          originalName: "launch.png",
          path: "https://uploads.postiz.com/a.png",
          createdAt: "2026-09-20T10:00:00.000Z",
        },
      ],
    }),
    "POST /public/v1/upload": () => ({
      id: "m2",
      path: "https://uploads.postiz.com/raw.mp4",
      status: "processing",
    }),
    "GET /public/v1/media/m2/status": () => ({
      id: "m2",
      path: "https://uploads.postiz.com/adjusted.mp4",
      status,
    }),
    "POST /public/v1/posts": () => [{ postId: "p1", integration: "int1" }],
    "GET /public/v1/posts": () => ({
      posts: [row({ publishDate: "2026-09-24T12:00:00.000Z", state: "QUEUE" })],
    }),
  });

  const adapter = postiz({ apiKey: "test", clock, fetch, adjustMedia: true });

  assert.deepEqual(await adapter.native.listMedia({ page: 2, search: "launch" }, context), {
    pages: 3,
    items: [
      {
        id: "m1",
        name: "a.png",
        originalName: "launch.png",
        path: "https://uploads.postiz.com/a.png",
        createdAt: "2026-09-20T10:00:00.000Z",
      },
    ],
  });

  const listCall = calls.find((call) => call.url.pathname === "/public/v1/media");

  assert.equal(listCall?.url.searchParams.get("page"), "2");
  assert.equal(listCall?.url.searchParams.get("search"), "launch");

  await assert.rejects(
    adapter.native.listMedia({ page: 0 }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );

  const ref = await adapter.media.upload(
    {
      kind: "video",
      source: {
        kind: "blob",
        blob: new Blob([new Uint8Array(8)], { type: "video/mp4" }),
        fingerprint: "v1",
      },
      mimeType: "video/mp4",
      filename: "clip.mp4",
    },
    x,
    context,
  );

  const upload = calls.find((call) => call.url.pathname === "/public/v1/upload")?.body;

  assert.ok(upload instanceof FormData);
  assert.equal(upload.get("adjust"), "true");

  assert.deepEqual(await adapter.native.getMediaStatus(ref, context), {
    id: "m2",
    path: "https://uploads.postiz.com/adjusted.mp4",
    status: "processing",
  });

  const social = createSocial({ backend: adapter, clock });

  const request = {
    targets: [{ account: x }],
    content: {
      text: "Adjusted",
      media: [
        {
          kind: "video" as const,
          source: { kind: "media-ref" as const, ref },
          mimeType: "video/mp4",
          filename: "clip.mp4",
        },
      ],
    },
  };

  const pending = (await social.posts.publish(request)).outcomes[0];

  assert.equal(pending?.state, "failed");
  assert.equal(pending.state === "failed" ? pending.code : undefined, "media_error");
  assert.equal(calls.filter((call) => call.url.pathname === "/public/v1/posts").length, 0);

  status = "ready";

  const result = await social.posts.publish(request);

  assert.equal(result.outcomes[0]?.state, "processing");

  const create = calls.find(
    (call) => call.method === "POST" && call.url.pathname === "/public/v1/posts",
  )?.body;

  assert.deepEqual(create, {
    type: "now",
    date: "2026-09-24T12:00:00.000Z",
    shortLink: false,
    tags: [],
    posts: [
      {
        integration: { id: "int1" },
        value: [
          {
            content: "Adjusted",
            image: [{ id: "m2", path: "https://uploads.postiz.com/adjusted.mp4" }],
          },
        ],
        settings: { who_can_reply_post: "everyone" },
      },
    ],
  });
});

it("Postiz lists an account's posts one week per page", async () => {
  const { calls, fetch } = fakePostiz({
    "GET /public/v1/posts": (call) =>
      call.url.searchParams.get("endDate") === "2026-10-24T12:00:00.000Z"
        ? {
            posts: [
              row({ id: "p1", publishDate: "2026-10-20T09:00:00.000Z", state: "QUEUE" }),
              row({
                id: "p2",
                publishDate: "2026-10-22T09:00:00.000Z",
                state: "PUBLISHED",
                releaseURL: "https://x.com/demo/status/1",
              }),
              row({
                id: "p3",
                publishDate: "2026-10-21T09:00:00.000Z",
                integration: { id: "int2", providerIdentifier: "x" },
              }),
            ],
          }
        : { posts: [] },
  });

  const social = createSocial({ backend: postiz({ apiKey: "test", clock, fetch }), clock });

  const first = await social.posts.list(x, { limit: 1 });

  assert.deepEqual(first.items, [
    {
      id: "p2@2026-10-22T09:00:00.000Z",
      publishDate: "2026-10-22T09:00:00.000Z",
      state: "PUBLISHED",
      text: "hello",
      url: "https://x.com/demo/status/1",
    },
  ]);
  assert.equal(calls[0]?.url.searchParams.get("startDate"), "2026-10-17T12:00:00.000Z");
  assert.equal(calls[0]?.url.searchParams.get("endDate"), "2026-10-24T12:00:00.000Z");

  const second = await social.posts.list(x, { limit: 1, cursor: string(first.nextCursor) });

  assert.deepEqual(
    second.items.map((item) => item["id"]),
    ["p1@2026-10-20T09:00:00.000Z"],
  );

  const third = await social.posts.list(x, { limit: 1, cursor: string(second.nextCursor) });

  assert.deepEqual(third.items, []);
  assert.equal(calls[2]?.url.searchParams.get("endDate"), "2026-10-17T12:00:00.000Z");
  assert.ok(third.nextCursor !== undefined);

  await assert.rejects(
    social.posts.list(x, { cursor: "2026-10-01" }),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Postiz changes status and settings of an unpublished post", async () => {
  let state = "QUEUE";

  const { calls, fetch } = fakePostiz({
    "GET /public/v1/posts": () => ({ posts: [row({ state })] }),
    "PUT /public/v1/posts/p1/status": () => ({ id: "p1", state: "DRAFT" }),
    "PUT /public/v1/posts/p1/settings": () => ({
      postId: "p1",
      publishDate: "2026-09-25T09:00:00",
    }),
  });

  const adapter = postiz({ apiKey: "test", clock, fetch });

  assert.deepEqual(await adapter.native.changeStatus(delivery, "draft", context), {
    state: "DRAFT",
  });
  assert.deepEqual(calls.find((call) => call.url.pathname === "/public/v1/posts/p1/status")?.body, {
    status: "draft",
  });

  await assert.rejects(
    adapter.native.changeStatus(delivery, "schedule", context),
    (error) => error instanceof SocialError && error.code === "ambiguous_outcome",
  );

  assert.deepEqual(
    await adapter.native.updateSettings(delivery, { who_can_reply_post: "following" }, context),
    { publishDate: "2026-09-25T09:00:00" },
  );
  assert.deepEqual(
    calls.find((call) => call.url.pathname === "/public/v1/posts/p1/settings")?.body,
    { settings: { who_can_reply_post: "following" } },
  );

  state = "PUBLISHED";

  await assert.rejects(
    adapter.native.updateSettings(delivery, { who_can_reply_post: "following" }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
  await assert.rejects(
    adapter.native.changeStatus(delivery, "draft", context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Postiz resolves a published post whose platform ID is missing", async () => {
  const record: BackendPostRef = {
    kind: "backend-post",
    version: 1,
    backend: "default",
    platform: "x",
    accountId: "int1",
    recordId: `p1@${future}`,
  };

  let releaseId = "missing";

  const { calls, fetch } = fakePostiz({
    "GET /public/v1/posts": () => ({ posts: [row({ state: "PUBLISHED", releaseId })] }),
    "GET /public/v1/posts/p1/missing": () => [
      { id: "7321456789012345678", url: "https://p16-sign.tiktokcdn-us.com/obj/cover.jpeg" },
    ],
    "PUT /public/v1/posts/p1/release-id": (call) => ({
      id: "p1",
      releaseId:
        call.body !== undefined && isRecord(call.body) ? (call.body["releaseId"] ?? null) : null,
    }),
  });

  const adapter = postiz({ apiKey: "test", clock, fetch });

  assert.deepEqual(await adapter.native.listMissingContent(record, context), [
    { id: "7321456789012345678", url: "https://p16-sign.tiktokcdn-us.com/obj/cover.jpeg" },
  ]);

  await adapter.native.setReleaseId(record, "7321456789012345678", context);
  assert.deepEqual(
    calls.find((call) => call.url.pathname === "/public/v1/posts/p1/release-id")?.body,
    { releaseId: "7321456789012345678" },
  );

  await assert.rejects(
    adapter.native.setReleaseId(record, "not an id", context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );

  releaseId = "7321456789012345678";

  await assert.rejects(
    adapter.native.listMissingContent(record, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

function isRecord(value: JsonValue | FormData): value is JsonObject {
  return !(value instanceof FormData) && isJsonObject(value);
}

it("Postiz reads channel analytics as account metrics", async () => {
  const { calls, fetch } = fakePostiz({
    "GET /public/v1/analytics/int1": () => [
      {
        label: "Followers",
        data: [
          { total: "120", date: "2026-09-23" },
          { total: "125", date: "2026-09-24" },
        ],
        percentageChange: 4,
      },
      { label: "Impressions", data: [{ total: 900, date: "2026-09-24" }] },
    ],
  });

  const social = createSocial({ backend: postiz({ apiKey: "test", clock, fetch }), clock });

  const metrics = await social.analytics.getAccountMetrics(x);

  assert.deepEqual(
    metrics.map((metric) => [metric.name, metric.value, metric.measuredAt, metric.source]),
    [
      ["followers", 125, "2026-09-24T00:00:00.000Z", "postiz:x:account"],
      ["impressions", 900, "2026-09-24T00:00:00.000Z", "postiz:x:account"],
    ],
  );
  assert.equal(calls[0]?.url.searchParams.get("date"), "30");
});

it("Postiz lists workspace notifications", async () => {
  const { calls, fetch } = fakePostiz({
    "GET /public/v1/notifications": () => ({
      notifications: [
        {
          id: "n1",
          content: "Your post failed to publish",
          link: null,
          createdAt: "2026-09-24T10:00:00.000Z",
        },
      ],
      total: 1,
      page: 0,
      limit: 100,
      hasMore: false,
    }),
  });

  const adapter = postiz({ apiKey: "test", fetch });

  assert.deepEqual(await adapter.native.listNotifications({}, context), {
    hasMore: false,
    items: [
      { id: "n1", content: "Your post failed to publish", createdAt: "2026-09-24T10:00:00.000Z" },
    ],
  });
  assert.equal(calls[0]?.url.searchParams.get("page"), "0");
});

it("Postiz starts AI video generation and YouTube clipping only when called", async () => {
  const { calls, fetch } = fakePostiz({
    "POST /public/v1/generate-video": () => [
      { id: "v1", path: "https://uploads.postiz.com/generated.mp4" },
    ],
    "POST /public/v1/video/function": () => ({ voices: [{ id: "voice1", name: "Rachel" }] }),
    "POST /public/v1/clipping": () => ({ id: "0b6f1c1e-5f0a-4c55-9a53-2f1f6f7f7c11" }),
    "GET /public/v1/clipping/0b6f1c1e-5f0a-4c55-9a53-2f1f6f7f7c11": () => ({
      id: "0b6f1c1e-5f0a-4c55-9a53-2f1f6f7f7c11",
      url: "https://www.youtube.com/watch?v=VIDEO_ID",
      status: "completed",
      error: null,
      title: "How we built it",
      clips: [{ id: "c1", status: "completed", path: "https://uploads.postiz.com/c1.mp4" }],
    }),
    "GET /public/v1/clipping": () => ({
      pages: 1,
      results: [{ id: "0b6f1c1e-5f0a-4c55-9a53-2f1f6f7f7c11", status: "rendering", error: null }],
    }),
  });

  const adapter = postiz({ apiKey: "test", fetch });

  assert.equal(calls.length, 0);

  assert.deepEqual(
    await adapter.native.generateVideo(
      {
        type: "veo3",
        output: "vertical",
        customParams: {
          prompt: "Mountains at sunset",
          images: [{ id: "m1", path: "https://uploads.postiz.com/ref.png" }],
        },
      },
      context,
    ),
    [{ id: "v1", path: "https://uploads.postiz.com/generated.mp4" }],
  );
  assert.deepEqual(calls[0]?.body, {
    type: "veo3",
    output: "vertical",
    customParams: {
      prompt: "Mountains at sunset",
      images: [{ id: "m1", path: "https://uploads.postiz.com/ref.png" }],
    },
  });

  await assert.rejects(
    adapter.native.generateVideo(
      {
        type: "image-text-slides",
        output: "vertical",
        customParams: { images: [{ id: "m1", path: "https://uploads.postiz.com/ref.png" }] },
      },
      context,
    ),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );

  assert.deepEqual(
    await adapter.native.videoFunction(
      { functionName: "loadVoices", identifier: "image-text-slides" },
      context,
    ),
    { voices: [{ id: "voice1", name: "Rachel" }] },
  );

  assert.deepEqual(
    await adapter.native.startClipping(
      {
        url: "https://www.youtube.com/watch?v=VIDEO_ID",
        clips: 3,
        fit: "crop",
        integrations: ["int1"],
      },
      context,
    ),
    { id: "0b6f1c1e-5f0a-4c55-9a53-2f1f6f7f7c11" },
  );
  assert.deepEqual(
    calls.find((call) => call.method === "POST" && call.url.pathname === "/public/v1/clipping")
      ?.body,
    {
      url: "https://www.youtube.com/watch?v=VIDEO_ID",
      integrations: ["int1"],
      clips: 3,
      fit: "crop",
    },
  );

  await assert.rejects(
    adapter.native.startClipping({ url: "https://vimeo.com/1" }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
  await assert.rejects(
    adapter.native.startClipping({ url: "https://youtu.be/VIDEO_ID", clips: 11 }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );

  const clipping = await adapter.native.getClipping(
    "0b6f1c1e-5f0a-4c55-9a53-2f1f6f7f7c11",
    context,
  );

  assert.equal(clipping.status, "completed");
  assert.deepEqual(clipping.clips, [
    { id: "c1", status: "completed", path: "https://uploads.postiz.com/c1.mp4" },
  ]);

  assert.deepEqual(await adapter.native.listClippings({}, context), {
    pages: 1,
    items: [{ id: "0b6f1c1e-5f0a-4c55-9a53-2f1f6f7f7c11", status: "rendering", clips: [] }],
  });
});

it("Postiz declares no webhook verification because dashboard webhooks are unsigned [feature:postiz.webhooks.dashboard]", () => {
  const adapter = postiz({ apiKey: "test", fetch: async () => Response.json({}) });

  assert.equal("webhooks" in adapter, false);
  assert.equal(
    adapter.capabilities.capabilities.some((entry) => entry.operation === "webhooks.verify"),
    false,
  );
});
