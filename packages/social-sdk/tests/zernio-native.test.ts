import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { zernio } from "../src/cloud/zernio.js";
import { zernioNative } from "../src/cloud/zernio-native.js";
import { definedFields } from "../src/core/fields.js";
import { isJsonValue } from "../src/transport/json.js";
import { object } from "../src/transport/validation.js";
import type {
  AdapterOperationContext,
  DeliveryRef,
  JsonObject,
  JsonValue,
  PlatformPostRef,
} from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body?: JsonObject;
  readonly headers: Headers;
}

/** A Zernio adapter whose fake fetch answers each `METHOD /path` from `routes`. */
function fake(routes: Readonly<Record<string, JsonValue>>) {
  const calls: Call[] = [];

  const options: Parameters<typeof zernio>[0] = {
    apiKey: "test",
    clock: () => new Date("2026-11-04T12:00:00Z"),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const path = url.pathname.replace(/^\/api/, "");
      const parsed: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));

      calls.push({
        method,
        path,
        query: Object.fromEntries(url.searchParams),
        headers: new Headers(init?.headers),
        ...definedFields({ body: isJsonValue(parsed) ? object(parsed) : undefined }),
      });

      const answer = routes[`${method} ${path}`];

      if (answer === undefined) return Response.json({ error: "no route" }, { status: 404 });

      return Response.json(answer);
    },
  };

  return { native: zernioNative(options), adapter: zernio(options), calls };
}

const tiktok = connectedAccountRef({ backend: "default", platform: "tiktok", accountId: "tt1" });

const x = connectedAccountRef({ backend: "default", platform: "x", accountId: "x1" });

const youtube = connectedAccountRef({ backend: "default", platform: "youtube", accountId: "yt1" });

const delivery: DeliveryRef = {
  kind: "delivery",
  version: 1,
  backend: "default",
  platform: "x",
  accountId: "x1",
  deliveryId: "post1",
};

const xPost: PlatformPostRef = {
  kind: "platform-post",
  version: 1,
  backend: "default",
  platform: "x",
  accountId: "x1",
  postId: "111",
  native: { backendRecordId: "post1" },
};

const record = (status: string, entry: JsonObject = {}): JsonObject => ({
  post: {
    _id: "post1",
    status,
    platforms: [{ platform: "twitter", accountId: "x1", status: "pending", ...entry }],
  },
});

it("starts a hosted connection through GET /v1/connect/{platform} and returns authUrl", async () => {
  const { native, calls } = fake({
    "GET /v1/connect/twitter": { authUrl: "https://zernio.com/connect/abc", state: "s1" },
  });

  const result = await native.createConnection(
    { platform: "x", profileId: "p1", redirectUrl: "https://app.example.com/cb" },
    context,
  );

  assert.deepEqual(result, { url: "https://zernio.com/connect/abc", providerState: "s1" });
  assert.deepEqual(calls[0]?.query, {
    profileId: "p1",
    redirect_url: "https://app.example.com/cb",
  });
});

it("connects Bluesky with an app password through /v1/connect/bluesky/credentials", async () => {
  const { native, calls } = fake({
    "POST /v1/connect/bluesky/credentials": {
      message: "ok",
      account: { _id: "bs1", platform: "bluesky", username: "user.bsky.social", isActive: true },
    },
  });

  const account = await native.connectBluesky(
    { identifier: "user.bsky.social", appPassword: "abcd-efgh-ijkl-mnop", state: "u1-p1" },
    context,
  );

  assert.equal(account.ref.accountId, "bs1");
  assert.equal(account.ref.platform, "bluesky");
  assert.deepEqual(calls[0]?.body, {
    identifier: "user.bsky.social",
    appPassword: "abcd-efgh-ijkl-mnop",
    state: "u1-p1",
  });
  await assert.rejects(
    native.connectBluesky({ identifier: "u", appPassword: "p", state: "nostate" }, context),
    { code: "invalid_input" },
  );
});

it("creates, updates and deletes profiles under /v1/profiles/ and moves accounts", async () => {
  const profile = { _id: "p2", name: "Tenant A", timezone: "Europe/Berlin", externalId: "t-a" };

  const { native, calls } = fake({
    "POST /v1/profiles": { message: "Created", profile },
    "PUT /v1/profiles/p2": { message: "Updated", profile: { ...profile, name: "Tenant B" } },
    "DELETE /v1/profiles/p2": { message: "Deleted" },
    "PATCH /v1/accounts/x1": { message: "Account moved", profileId: "p2" },
  });

  assert.deepEqual(
    await native.createProfile(
      { name: "Tenant A", timezone: "Europe/Berlin", externalId: "t-a" },
      context,
    ),
    profile,
  );
  assert.equal(
    (await native.updateProfile({ profileId: "p2", name: "Tenant B", description: null }, context))[
      "name"
    ],
    "Tenant B",
  );
  await native.deleteProfile({ profileId: "p2" }, context);
  await native.moveAccount({ account: x, profileId: "p2" }, context);

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    ["POST /v1/profiles", "PUT /v1/profiles/p2", "DELETE /v1/profiles/p2", "PATCH /v1/accounts/x1"],
  );
  assert.deepEqual(calls[1]?.body, { name: "Tenant B", description: null });
  assert.deepEqual(calls[3]?.body, { profileId: "p2" });
});

it("reads account /health without tokens and disconnects with DELETE", async () => {
  const { native, calls } = fake({
    "GET /v1/accounts/x1/health": {
      accountId: "x1",
      platform: "twitter",
      status: "warning",
      tokenStatus: { valid: true, expiresAt: "2026-11-05T00:00:00Z", needsRefresh: true },
      permissions: { canPost: true, canFetchAnalytics: false, missingRequired: ["tweet.read"] },
      issues: ["Token expires soon"],
      recommendations: ["Reconnect"],
      disconnectReason: null,
    },
    "DELETE /v1/accounts/x1": { message: "Disconnected" },
  });

  assert.deepEqual(await native.getAccountHealth({ account: x }, context), {
    status: "warning",
    disconnectReason: null,
    token: { valid: true, expiresAt: "2026-11-05T00:00:00Z", needsRefresh: true },
    permissions: { canPost: true, canFetchAnalytics: false, missingRequired: ["tweet.read"] },
    issues: ["Token expires soon"],
    recommendations: ["Reconnect"],
  });
  await native.disconnectAccount({ account: x }, context);
  assert.deepEqual(calls.at(-1)?.method, "DELETE");

  const other = fake({ "GET /v1/accounts/x1/health": { accountId: "x2", platform: "twitter" } });

  await assert.rejects(other.native.getAccountHealth({ account: x }, context), {
    code: "unauthorized",
  });
});

it("submits drafts, requiresApproval posts and queue slots, then reviews an approval", async () => {
  const { native, calls } = fake({
    "POST /v1/posts": record("pending_approval"),
    "GET /v1/posts/post1": record("pending_approval"),
    "POST /v1/posts/post1/review": record("scheduled"),
  });

  const approval = await native.submitPost(
    {
      account: x,
      content: { text: "Launch day" },
      options: { replySettings: "following" },
      submission: { kind: "approval", at: "2026-11-10T09:00:00Z", timeZone: "Europe/Berlin" },
    },
    context,
  );

  assert.equal(approval.state, "accepted");
  assert.deepEqual(calls[0]?.body, {
    content: "Launch day",
    mediaItems: [],
    platforms: [
      {
        platform: "twitter",
        accountId: "x1",
        platformSpecificData: { replySettings: "following" },
      },
    ],
    requiresApproval: true,
    scheduledFor: "2026-11-10T09:00:00Z",
    timezone: "Europe/Berlin",
  });

  await native.submitPost(
    { account: x, content: { text: "Draft" }, submission: { kind: "draft" } },
    context,
  );
  assert.equal(calls[1]?.body?.["isDraft"], true);

  await native.submitPost(
    {
      account: x,
      content: { text: "Queued" },
      submission: { kind: "queue", profileId: "p1", queueId: "q1" },
    },
    context,
  );
  assert.equal(calls[2]?.body?.["queuedFromProfile"], "p1");
  assert.equal(calls[2]?.body?.["queueId"], "q1");

  const reviewed = await native.reviewPost({ delivery, decision: "approve" }, context);

  assert.equal(reviewed.state, "scheduled");
  assert.deepEqual(calls.at(-1)?.body, { decision: "approve" });

  await assert.rejects(
    native.submitPost(
      { account: x, content: { text: "" }, submission: { kind: "draft" } },
      context,
    ),
    { code: "invalid_input" },
  );
});

it("reschedules a scheduled post with PUT and refuses a published one", async () => {
  const scheduled = fake({
    "GET /v1/posts/post1": record("scheduled"),
    "PUT /v1/posts/post1": record("scheduled"),
  });

  const outcome = await scheduled.native.reschedulePost(
    { delivery, text: "Moved", at: "2026-11-20T10:00:00Z", timeZone: "UTC" },
    context,
  );

  assert.equal(outcome.state, "scheduled");
  assert.deepEqual(scheduled.calls[1]?.body, {
    content: "Moved",
    scheduledFor: "2026-11-20T10:00:00Z",
    timezone: "UTC",
  });

  const published = fake({ "GET /v1/posts/post1": record("published") });

  await assert.rejects(published.native.reschedulePost({ delivery, text: "x" }, context), {
    code: "invalid_input",
  });
  assert.equal(published.calls.length, 1);
});

it("edits published text through /edit and returns X's new post ID", async () => {
  const { native, calls } = fake({
    "GET /v1/posts/post1": record("published", { status: "published", platformPostId: "111" }),
    "POST /v1/posts/post1/edit": { success: true, id: "222", url: "https://x.com/a/status/222" },
  });

  const edited = await native.updatePost({ post: xPost, text: "Fixed typo" }, context);

  assert.equal(edited.postId, "222");
  assert.deepEqual(calls[1]?.body, { platform: "twitter", content: "Fixed typo", accountId: "x1" });

  await assert.rejects(
    native.updatePost({ post: { ...xPost, platform: "instagram" }, text: "no" }, context),
    { code: "invalid_input" },
  );
});

it("updates YouTube metadata through update-metadata in direct video mode", async () => {
  const { native, calls } = fake({
    "POST /v1/posts/_/update-metadata": { success: true, updatedFields: ["title", "tags"] },
  });

  const result = await native.updateYouTubeMetadata(
    {
      post: { ...xPost, platform: "youtube", accountId: "yt1", postId: "vid1" },
      metadata: {
        title: "New title",
        tags: ["sdk"],
        thumbnailUrl: "https://cdn.example.test/t.jpg",
      },
    },
    context,
  );

  assert.deepEqual(result, { updatedFields: ["title", "tags"] });
  assert.deepEqual(calls[0]?.body, {
    platform: "youtube",
    videoId: "vid1",
    accountId: "yt1",
    title: "New title",
    tags: ["sdk"],
    thumbnailUrl: "https://cdn.example.test/t.jpg",
  });
  assert.equal(youtube.platform, "youtube");
});

it("retries a failed post through /retry and refuses other statuses", async () => {
  const failed = fake({
    "GET /v1/posts/post1": record("failed", { status: "failed" }),
    "POST /v1/posts/post1/retry": record("published", {
      status: "published",
      platformPostId: "333",
    }),
  });

  const outcome = await failed.native.retryPost({ delivery }, context);

  assert.equal(outcome.state, "published");
  assert.equal(failed.calls[1]?.path, "/v1/posts/post1/retry");

  const scheduled = fake({ "GET /v1/posts/post1": record("scheduled") });

  await assert.rejects(scheduled.native.retryPost({ delivery }, context), {
    code: "invalid_input",
  });
});

it("dry-runs a target through validate/post", async () => {
  const { native, calls } = fake({
    "POST /v1/tools/validate/post": {
      valid: false,
      errors: [{ platform: "twitter", field: "content", message: "Too long" }],
      warnings: [],
    },
  });

  const result = await native.validatePost(
    { account: x, content: { text: "Hello" }, options: { madeWithAi: true } },
    context,
  );

  assert.deepEqual(result, {
    valid: false,
    errors: [{ platform: "twitter", field: "content", message: "Too long" }],
    warnings: [],
    localIssues: [],
  });
  assert.deepEqual(calls[0]?.body, {
    content: "Hello",
    mediaItems: [],
    platforms: [
      { platform: "twitter", accountId: "x1", platformSpecificData: { madeWithAi: true } },
    ],
  });
});

it("validates the same YouTube fields and thread a publish sends", async () => {
  const { native, calls } = fake({
    "POST /v1/tools/validate/post": { valid: true, errors: [], warnings: [] },
  });

  const video = {
    kind: "video",
    mimeType: "video/mp4",
    source: { kind: "https-url", url: "https://cdn.example.test/tour.mp4" },
  } as const;

  await native.validatePost(
    {
      account: youtube,
      content: { text: "Tour", media: [video] },
      options: { title: "Walkthrough", visibility: "unlisted", madeForKids: false },
    },
    context,
  );

  assert.deepEqual(calls[0]?.body?.["platforms"], [
    {
      platform: "youtube",
      accountId: "yt1",
      platformSpecificData: { title: "Walkthrough", visibility: "unlisted", madeForKids: false },
    },
  ]);

  await native.validatePosts(
    {
      content: { text: "Root" },
      targets: [{ account: x, options: { threadItems: [{ text: "Reply" }] } }],
    },
    context,
  );

  assert.deepEqual(calls[1]?.body?.["platforms"], [
    {
      platform: "twitter",
      accountId: "x1",
      platformSpecificData: { threadItems: [{ content: "Root" }, { content: "Reply" }] },
    },
  ]);
});

it("refuses connections-only LinkedIn visibility on native submissions", async () => {
  const linkedin = connectedAccountRef({
    backend: "default",
    platform: "linkedin",
    accountId: "li1",
  });

  const { native, calls } = fake({ "POST /v1/posts": record("draft") });

  await assert.rejects(
    native.submitPost(
      {
        account: linkedin,
        content: { text: "Members only" },
        options: { visibility: "connections" },
        submission: { kind: "draft" },
      },
      context,
    ),
    { code: "invalid_input", message: /linkedin\.visibility_unsupported/ },
  );
  assert.equal(calls.length, 0);
});

it("reads TikTok creator-info for the pre-post screen", async () => {
  const { native, calls } = fake({
    "GET /v1/accounts/tt1/tiktok/creator-info": {
      creator: { nickname: "Studio", avatarUrl: "https://cdn/a.jpg", canPostMore: true },
      privacyLevels: [
        { value: "PUBLIC_TO_EVERYONE", label: "Everyone" },
        { value: "SELF_ONLY", label: "Only me" },
      ],
      postingLimits: { maxVideoDurationSec: 600 },
      commercialContentTypes: [{ value: "brand_organic", label: "Your brand" }],
    },
  });

  assert.deepEqual(await native.creatorInfo({ account: tiktok, mediaType: "video" }, context), {
    creator: { nickname: "Studio", canPostMore: true },
    privacyLevels: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
    commercialContentTypes: ["brand_organic"],
    maxVideoDurationSec: 600,
  });
  assert.deepEqual(calls[0]?.query, { mediaType: "video" });
});

it("lists live platform posts from /v1/accounts/${accountId}/posts", async () => {
  const { native, calls } = fake({
    "GET /v1/accounts/x1/posts": {
      status: "success",
      posts: [{ id: "n1", platform: "twitter", message: "hi", likeCount: 3, picture: "https://p" }],
    },
  });

  assert.deepEqual(await native.listPlatformPosts({ account: x }, context), [
    { id: "n1", message: "hi", likeCount: 3 },
  ]);
  assert.equal(calls[0]?.path, "/v1/accounts/x1/posts");
});
