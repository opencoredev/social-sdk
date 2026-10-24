import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { discoverFacebookPages, facebook } from "../src/platforms/facebook.js";
import { isJsonValue } from "../src/transport/json.js";
import { isJsonObject } from "../src/transport/validation.js";
import type { AdapterOperationContext, JsonObject, JsonValue } from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-10-24T12:00:00.000Z");

const page = connectedAccountRef({ backend: "default", platform: "facebook", accountId: "123" });

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: JsonObject | FormData | undefined;
}

/** Replies in order and records every request. */
function recorder(responses: readonly JsonValue[]) {
  const calls: Call[] = [];
  let index = 0;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const raw = init?.body;
    let body: JsonObject | FormData | undefined;

    if (raw instanceof FormData) body = raw;
    else if (raw !== undefined && raw !== null) {
      const parsed: unknown = JSON.parse(String(raw));

      if (isJsonValue(parsed) && isJsonObject(parsed)) body = parsed;
    }

    calls.push({
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body,
    });

    const response = responses[index++];

    if (response === undefined) throw new Error("Unexpected request");

    return Response.json(response);
  };

  return { calls, fetch };
}

function adapter(responses: readonly JsonValue[]) {
  const { calls, fetch } = recorder(responses);

  return {
    calls,
    adapter: facebook({ auth: { pageId: "123", accessToken: "page-token" }, fetch, clock }),
  };
}

describe("facebook pages adapter", () => {
  it("publishes a text post with a link to the Page feed", async () => {
    const { calls, adapter: fb } = adapter([{ id: "123_456" }]);
    const social = createSocial({ backend: fb, clock });

    const result = await social.posts.publish({
      targets: [{ account: page }],
      content: { text: "Hello", link: { url: "https://example.com/launch" } },
    });

    const outcome = result.outcomes[0];

    assert.equal(outcome?.state, "published");
    assert.equal(outcome?.state === "published" ? outcome.post.postId : undefined, "123_456");
    assert.equal(calls[0]?.url.href, "https://graph.facebook.com/v25.0/123/feed");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer page-token");
    assert.deepEqual(calls[0]?.body, { message: "Hello", link: "https://example.com/launch" });
  });

  it("schedules natively with a Unix timestamp and rejects times outside Meta's window", async () => {
    const { calls, adapter: fb } = adapter([{ id: "123_789" }]);
    const social = createSocial({ backend: fb, clock });

    const result = await social.posts.publish({
      targets: [{ account: page }],
      content: { text: "Later" },
      schedule: { at: "2026-10-25T12:00:00.000Z" },
    });

    const outcome = result.outcomes[0];

    assert.equal(outcome?.state, "scheduled");
    assert.equal(outcome?.state === "scheduled" ? outcome.job.jobId : undefined, "123_789");
    assert.deepEqual(calls[0]?.body, {
      message: "Later",
      published: false,
      scheduled_publish_time: String(Date.parse("2026-10-25T12:00:00.000Z") / 1000),
    });

    for (const at of ["2026-10-24T12:05:00.000Z", "2026-12-01T12:00:00.000Z"]) {
      const plan = social.posts.prepare({
        targets: [{ account: page }],
        content: { text: "Out of window" },
        schedule: { at },
      });

      assert.ok(plan.issues.some((item) => item.code === "facebook.schedule_window"));
    }
  });

  it("publishes a single photo and returns the feed post ID", async () => {
    const { calls, adapter: fb } = adapter([{ id: "photo1", post_id: "123_900" }]);
    const social = createSocial({ backend: fb, clock });

    const result = await social.posts.publish({
      targets: [{ account: page }],
      content: {
        text: "Photo",
        media: [
          {
            kind: "image",
            mimeType: "image/jpeg",
            altText: "A red bike",
            source: { kind: "https-url", url: "https://cdn.example.com/bike.jpg" },
          },
        ],
      },
    });

    assert.equal(
      result.outcomes[0]?.state === "published" ? result.outcomes[0].post.postId : undefined,
      "123_900",
    );
    assert.equal(calls[0]?.url.pathname, "/v25.0/123/photos");
    assert.deepEqual(calls[0]?.body, {
      url: "https://cdn.example.com/bike.jpg",
      caption: "Photo",
      alt_text_custom: "A red bike",
    });
  });

  it("builds scheduled multi-photo posts from temporary unpublished photos", async () => {
    const { calls, adapter: fb } = adapter([{ id: "p1" }, { id: "p2" }, { id: "123_901" }]);
    const social = createSocial({ backend: fb, clock });

    const image = (name: string) => ({
      kind: "image" as const,
      mimeType: "image/png",
      filename: `${name}.png`,
      source: { kind: "blob" as const, blob: new Blob(["x"]), fingerprint: name },
    });

    const result = await social.posts.publish({
      targets: [{ account: page }],
      content: { text: "Album", media: [image("a"), image("b")] },
      schedule: { at: "2026-10-26T12:00:00.000Z" },
    });

    assert.equal(result.outcomes[0]?.state, "scheduled");
    const upload = calls[0]?.body;

    assert.ok(upload instanceof FormData);
    assert.equal(upload.get("published"), "false");
    assert.equal(upload.get("temporary"), "true");
    assert.ok(upload.get("source") instanceof Blob);
    assert.deepEqual(calls[2]?.body, {
      attached_media: [{ media_fbid: "p1" }, { media_fbid: "p2" }],
      message: "Album",
      published: false,
      scheduled_publish_time: String(Date.parse("2026-10-26T12:00:00.000Z") / 1000),
    });
  });

  it("keeps uploaded photo IDs when a multi-photo post fails part way", async () => {
    const calls: string[] = [];

    const fb = facebook({
      auth: { pageId: "123", accessToken: "page-token" },
      clock,
      fetch: async (input) => {
        calls.push(String(input));

        return calls.length === 1
          ? Response.json({ id: "p1" })
          : Response.json({ error: { message: "bad" } }, { status: 400 });
      },
    });

    const image = {
      kind: "image" as const,
      mimeType: "image/jpeg",
      source: { kind: "https-url" as const, url: "https://cdn.example.com/a.jpg" },
    };

    await assert.rejects(
      fb.posts!.publishTarget(
        {
          targetIndex: 0,
          targetKey: "k",
          account: page,
          content: { text: "Album", media: [image, image] },
        },
        context,
      ),
      { code: "upstream_failure", details: { unpublishedPhotoIds: ["p1"] } },
    );
  });

  it("submits Page videos on graph-video and reconciles them through posts.status", async () => {
    const { calls, adapter: fb } = adapter([
      { id: "vid1" },
      {
        id: "vid1",
        status: { video_status: "processing", processing_phase: { status: "in_progress" } },
      },
      {
        id: "vid1",
        status: {
          video_status: "ready",
          publishing_phase: { status: "complete", publish_status: "published" },
        },
      },
    ]);

    const social = createSocial({ backend: fb, clock });

    const result = await social.posts.publish({
      targets: [{ account: page }],
      content: {
        text: "Clip",
        media: [
          {
            kind: "video",
            mimeType: "video/mp4",
            source: { kind: "https-url", url: "https://cdn.example.com/clip.mp4" },
          },
        ],
      },
    });

    const outcome = result.outcomes[0];

    assert.equal(outcome?.state, "processing");
    assert.equal(calls[0]?.url.href, "https://graph-video.facebook.com/v25.0/123/videos");
    assert.deepEqual(calls[0]?.body, {
      file_url: "https://cdn.example.com/clip.mp4",
      description: "Clip",
    });

    assert.ok(outcome?.delivery);
    assert.equal((await social.posts.getDelivery(outcome.delivery)).state, "processing");

    const done = await social.posts.getDelivery(outcome.delivery);

    assert.equal(done.state, "published");
    assert.deepEqual(done.state === "published" ? done.post.native : undefined, {
      objectType: "video",
    });
  });

  it("requires affirmative publication evidence before reporting published", async () => {
    const { adapter: fb } = adapter([
      { id: "123_1", is_published: true },
      { id: "123_2", is_published: false, scheduled_publish_time: 1793520000 },
      { id: "123_3" },
      { id: "123_4", is_published: false },
      { id: "vid9", status: { video_status: "ready", publishing_phase: { status: "complete" } } },
      {
        id: "vid9",
        status: {
          video_status: "ready",
          publishing_phase: { status: "complete", publish_status: "draft" },
        },
      },
    ]);

    const ref = (deliveryId: string) => ({
      kind: "delivery" as const,
      version: 1 as const,
      backend: "default",
      platform: "facebook",
      accountId: "123",
      deliveryId,
    });

    const states = [];

    for (const id of ["123_1", "123_2", "123_3", "123_4", "vid9", "vid9"])
      states.push((await fb.posts!.getDelivery!(ref(id), context)).state);

    assert.deepEqual(states, [
      "published",
      "scheduled",
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ]);
  });

  it("publishes a Reel through start, hosted upload, and finish phases", async () => {
    const { calls, adapter: fb } = adapter([
      { video_id: "reel1", upload_url: "https://rupload.facebook.com/video-upload/v25.0/reel1" },
      { success: true },
      { success: true },
    ]);

    const social = createSocial({ backend: fb, clock });

    const result = await social.posts.publish({
      targets: [{ account: page, options: { reel: true } }],
      content: {
        text: "Reel",
        media: [
          {
            kind: "video",
            mimeType: "video/mp4",
            source: { kind: "https-url", url: "https://cdn.example.com/reel.mp4" },
          },
        ],
      },
    });

    assert.equal(result.outcomes[0]?.state, "processing");
    assert.deepEqual(calls[0]?.body, { upload_phase: "start" });
    assert.equal(calls[1]?.url.href, "https://rupload.facebook.com/video-upload/v25.0/reel1");
    assert.equal(calls[1]?.headers.get("authorization"), "OAuth page-token");
    assert.equal(calls[1]?.headers.get("file_url"), "https://cdn.example.com/reel.mp4");
    assert.deepEqual(calls[2]?.body, {
      upload_phase: "finish",
      video_id: "reel1",
      video_state: "PUBLISHED",
      description: "Reel",
    });
  });

  it("rejects an upload URL outside rupload.facebook.com before sending the video", async () => {
    const { calls, adapter: fb } = adapter([
      { video_id: "reel1", upload_url: "https://attacker.example/upload" },
    ]);

    await assert.rejects(
      fb.native!.publishReel({
        account: page,
        videoUrl: "https://cdn.example.com/reel.mp4",
        context,
      }),
      { code: "upstream_failure" },
    );
    assert.equal(calls.length, 1);
  });

  it("validates media, options, replies, and the configured Page before dispatch", () => {
    const social = createSocial({ backend: adapter([]).adapter, clock });

    const issues = (request: Parameters<typeof social.posts.prepare>[0]) =>
      social.posts.prepare(request).issues.map((item) => item.code);

    assert.ok(
      issues({
        targets: [{ account: { ...page, accountId: "999" } }],
        content: { text: "x" },
      }).includes("facebook.account"),
    );
    assert.ok(
      issues({
        targets: [{ account: page, options: { reel: true } }],
        content: { text: "x" },
      }).includes("facebook.reel_media"),
    );
    assert.ok(
      issues({
        targets: [
          {
            account: page,
            replyTo: {
              kind: "platform-post",
              version: 1,
              backend: "default",
              platform: "facebook",
              accountId: "123",
              postId: "123_1",
            },
          },
        ],
        content: { text: "x" },
      }).includes("reply.use_comments"),
    );
    assert.ok(
      issues({
        targets: [{ account: page }],
        content: {
          media: [
            {
              kind: "video",
              mimeType: "video/mp4",
              source: { kind: "https-url", url: "https://cdn.example.com/a.mp4" },
            },
            {
              kind: "image",
              mimeType: "image/jpeg",
              source: { kind: "https-url", url: "https://cdn.example.com/a.jpg" },
            },
          ],
        },
      }).includes("facebook.media_mix"),
    );
  });

  it("lists posts with Graph cursors and refuses another Page's reference", async () => {
    const { calls, adapter: fb } = adapter([
      {
        data: [{ id: "123_1", message: "Hi", from: { id: "secret" } }],
        paging: { cursors: { after: "c2" }, next: "https://graph.facebook.com/next" },
      },
    ]);

    const result = await fb.posts!.list!(page, { limit: 10 }, context);

    assert.deepEqual(result, { items: [{ id: "123_1", message: "Hi" }], nextCursor: "c2" });
    assert.equal(calls[0]?.url.searchParams.get("limit"), "10");

    await assert.rejects(fb.posts!.list!({ ...page, accountId: "999" }, {}, context), {
      code: "unauthorized",
    });
  });

  it("reads, replies to, hides, and deletes comments", async () => {
    const { calls, adapter: fb } = adapter([
      { data: [{ id: "c1", message: "Nice" }], paging: { cursors: { after: "x" } } },
      { id: "c2" },
      { success: true },
      { success: true },
    ]);

    const post = {
      kind: "platform-post" as const,
      version: 1 as const,
      backend: "default",
      platform: "facebook",
      accountId: "123",
      postId: "123_1",
    };

    const comments = await fb.comments!.list(post, {}, context);

    assert.deepEqual(comments.items, [
      { id: "c1", message: "Nice", text: "Nice", native: { id: "c1", message: "Nice" } },
    ]);
    assert.equal(comments.nextCursor, undefined);

    const reply = await fb.comments!.reply(
      {
        kind: "comment",
        version: 1,
        backend: "default",
        platform: "facebook",
        accountId: "123",
        postId: "123_1",
        commentId: "c1",
      },
      { text: "Thanks" },
      context,
    );

    assert.equal(reply.commentId, "c2");
    assert.equal(calls[1]?.url.pathname, "/v25.0/c1/comments");

    await fb.native!.moderateComment({ account: page, commentId: "c1", hidden: true, context });
    assert.deepEqual(calls[2]?.body, { is_hidden: true });

    await fb.native!.deleteComment({ account: page, commentId: "c1", context });
    assert.equal(calls[3]?.method, "DELETE");
  });

  it("treats an unconfirmed deletion as ambiguous", async () => {
    const { adapter: fb } = adapter([{ success: false }]);

    await assert.rejects(
      fb.posts!.removeFromPlatform!(
        {
          kind: "platform-post",
          version: 1,
          backend: "default",
          platform: "facebook",
          accountId: "123",
          postId: "123_1",
        },
        context,
      ),
      { code: "ambiguous_outcome" },
    );
  });

  it("cancels scheduled posts by deleting the unpublished object", async () => {
    const { calls, adapter: fb } = adapter([{ success: true }]);

    const result = await fb.posts!.cancelScheduled!(
      {
        kind: "scheduled-job",
        version: 1,
        backend: "default",
        platform: "facebook",
        accountId: "123",
        jobId: "123_789",
      },
      context,
    );

    assert.deepEqual(result, { state: "cancelled", backendRecord: "deleted" });
    assert.equal(calls[0]?.url.pathname, "/v25.0/123_789");
  });

  it("reads post engagement, Page counts, and a bounded daily report", async () => {
    const { calls, adapter: fb } = adapter([
      {
        id: "123_1",
        reactions: { data: [], summary: { total_count: 7 } },
        comments: { data: [], summary: { total_count: 2 } },
        shares: { count: 1 },
      },
      { id: "123", followers_count: 50, fan_count: 40 },
      {
        data: [
          {
            name: "page_follows",
            period: "day",
            values: [
              { value: 3, end_time: "2026-10-02T07:00:00+0000" },
              { value: { breakdown: 1 }, end_time: "2026-10-03T07:00:00+0000" },
            ],
          },
        ],
      },
    ]);

    const post = {
      kind: "platform-post" as const,
      version: 1 as const,
      backend: "default",
      platform: "facebook",
      accountId: "123",
      postId: "123_1",
    };

    assert.deepEqual(
      (await fb.analytics!.getPostMetrics(post, context)).map((metric) => [
        metric.name,
        metric.value,
        metric.canonicalName,
      ]),
      // Reactions include more than likes, so they keep only the provider name.
      [
        ["reactions", 7, undefined],
        ["comments", 2, "comments"],
        ["shares", 1, "shares"],
      ],
    );
    assert.deepEqual(
      (await fb.analytics!.getAccountMetrics!(page, context)).map((metric) => [
        metric.name,
        metric.value,
        metric.canonicalName,
      ]),
      [
        ["followers_count", 50, "followers"],
        ["fan_count", 40, undefined],
      ],
    );

    const report = await fb.analytics!.getReport!(
      page,
      { from: "2026-10-01", to: "2026-10-02", metrics: ["page_follows"], dimensions: ["endTime"] },
      context,
    );

    assert.deepEqual(report.rows, [
      { dimensions: { endTime: "2026-10-02T07:00:00+0000" }, metrics: { page_follows: 3 } },
    ]);
    assert.equal(calls[2]?.url.searchParams.get("until"), "2026-10-03");

    await assert.rejects(
      fb.analytics!.getReport!(
        page,
        { from: "2026-01-01", to: "2026-06-01", metrics: ["page_follows"] },
        context,
      ),
      { code: "invalid_input" },
    );
  });

  it("discovers manageable Pages and flags publishing permission", async () => {
    const { calls, fetch } = recorder([
      {
        data: [
          { id: "1", name: "Shop", tasks: ["CREATE_CONTENT", "MANAGE"], access_token: "pt-1" },
          { id: "2", name: "Fans", tasks: ["ANALYZE"], access_token: "pt-2" },
        ],
        paging: { cursors: { after: "n" }, next: "https://graph.facebook.com/next" },
      },
    ]);

    const result = await discoverFacebookPages({ userAccessToken: "user-token", fetch });

    assert.deepEqual(
      result.items.map((item) => [item.pageId, item.canPublish, item.accessToken]),
      [
        ["1", true, "pt-1"],
        ["2", false, "pt-2"],
      ],
    );
    assert.equal(result.nextCursor, "n");
    assert.equal(calls[0]?.url.pathname, "/v25.0/me/accounts");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer user-token");
  });

  it("verifies Meta signatures and decodes Page feed comments", async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        object: "page",
        entry: [
          { id: "123", changes: [{ field: "feed", value: { item: "comment", verb: "add" } }] },
        ],
      }),
    );

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("app-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = Array.from(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, body)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");

    const fb = facebook({
      auth: { pageId: "123", accessToken: "t" },
      webhookSecret: "app-secret",
      clock,
    });

    const headers = new Headers({ "X-Hub-Signature-256": `sha256=${signature}` });

    assert.deepEqual(await fb.webhooks!.verify({ headers, body }, context), {
      valid: true,
      method: "hmac",
    });

    const event = await fb.webhooks!.decode({ headers, body }, context);

    assert.equal(event["type"], "comment.received");
    assert.deepEqual(event["accountIds"], ["123"]);

    await assert.rejects(
      fb.webhooks!.verify(
        { headers: new Headers({ "X-Hub-Signature-256": "sha256=00" }), body },
        context,
      ),
      { code: "unauthorized" },
    );
  });
});
