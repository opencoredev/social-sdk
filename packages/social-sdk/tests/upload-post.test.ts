import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { uploadPost } from "../src/cloud/upload-post.js";
import type { AdapterOperationContext, ConnectedAccountRef, JsonValue } from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-10-24T12:00:00.000Z");

const x = connectedAccountRef({ backend: "default", platform: "x", accountId: "brand" });

const linkedin = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: "brand",
});

const bluesky = connectedAccountRef({
  backend: "default",
  platform: "bluesky",
  accountId: "brand",
});

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: BodyInit | null | undefined;
}

function recorder(responses: readonly (JsonValue | Response)[]) {
  const calls: Call[] = [];
  let index = 0;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: init?.body,
    });

    const response = responses[index++];

    if (response === undefined) throw new Error("Unexpected request");

    return response instanceof Response ? response : Response.json(response);
  };

  return { calls, fetch };
}

function form(call: Call | undefined): FormData {
  assert.ok(call?.body instanceof FormData);

  return call.body;
}

describe("upload-post managed backend", () => {
  it("lists connected platform accounts across profiles with the Apikey header", async () => {
    const { calls, fetch } = recorder([
      {
        success: true,
        profiles: [
          {
            username: "brand",
            social_accounts: {
              x: { handle: "brandx", display_name: "Brand X" },
              linkedin: { handle: "brand-li", reauth_required: true },
              pinterest: { handle: "pins" },
              tiktok: null,
              instagram: "",
            },
          },
          { username: "other", display_name: "Other", social_accounts: { bluesky: "other.bsky" } },
        ],
      },
    ]);

    const adapter = uploadPost({ apiKey: "key", fetch, clock });
    const page = await adapter.accounts.list({ limit: 2 }, context);

    assert.equal(calls[0]?.url.href, "https://api.upload-post.com/api/uploadposts/users");
    assert.equal(calls[0]?.headers.get("authorization"), "Apikey key");
    assert.deepEqual(
      page.items.map((item) => [
        item.ref.platform,
        item.ref.accountId,
        item.status,
        item.displayName,
      ]),
      [
        ["x", "brand", "connected", "Brand X"],
        ["linkedin", "brand", "reconnect-required", "brand-li"],
      ],
    );
    assert.equal(page.nextCursor, "2");
  });

  it("publishes text with one platform, the idempotency key, and a native post ID", async () => {
    const { calls, fetch } = recorder([
      {
        success: true,
        results: { x: { success: true, post_id: "1700", url: "https://x.com/brandx/status/1700" } },
      },
    ]);

    const social = createSocial({ backend: uploadPost({ apiKey: "key", fetch, clock }), clock });

    const result = await social.posts.publish({
      targets: [{ account: x, options: { replySettings: "following" } }],
      content: { text: "Hello" },
      idempotencyKey: "launch-1",
    });

    const outcome = result.outcomes[0];

    assert.equal(outcome?.state, "published");
    assert.equal(outcome?.state === "published" ? outcome.post.postId : undefined, "1700");
    assert.equal(
      outcome?.state === "published" ? outcome.url : undefined,
      "https://x.com/brandx/status/1700",
    );
    assert.equal(calls[0]?.url.pathname, "/api/upload_text");
    assert.ok(calls[0]?.headers.get("idempotency-key"));

    const body = form(calls[0]);

    assert.equal(body.get("user"), "brand");
    assert.deepEqual(body.getAll("platform[]"), ["x"]);
    assert.equal(body.get("title"), "Hello");
    assert.equal(body.get("reply_settings"), "following");
  });

  it("does not call a result without a native post ID published", async () => {
    const { fetch } = recorder([
      { success: true, results: { x: { success: true, url: "https://x.com" } } },
    ]);

    const social = createSocial({ backend: uploadPost({ apiKey: "key", fetch, clock }), clock });

    const result = await social.posts.publish({
      targets: [{ account: x }],
      content: { text: "Hi" },
    });

    assert.equal(result.outcomes[0]?.state, "unknown");
  });

  it("routes photos, videos, and LinkedIn documents to their upload endpoints", async () => {
    const { calls, fetch } = recorder([
      { success: true, message: "Upload initiated", request_id: "req-photo", total_platforms: 1 },
      { success: true, request_id: "req-video" },
      {
        success: true,
        request_id: "req-doc",
        results: { linkedin: { success: true, post_id: "urn:li:share:9" } },
      },
    ]);

    const social = createSocial({ backend: uploadPost({ apiKey: "key", fetch, clock }), clock });

    const photos = await social.posts.publish({
      targets: [{ account: x }],
      content: {
        text: "Two photos",
        media: [
          {
            kind: "image",
            mimeType: "image/png",
            source: { kind: "https-url", url: "https://cdn.example.com/a.png" },
          },
          {
            kind: "image",
            mimeType: "image/png",
            filename: "b.png",
            source: { kind: "blob", blob: new Blob(["b"]), fingerprint: "b" },
          },
        ],
      },
    });

    assert.equal(photos.outcomes[0]?.state, "accepted");
    assert.equal(calls[0]?.url.pathname, "/api/upload_photos");
    const photoForm = form(calls[0]).getAll("photos[]");

    assert.equal(photoForm[0], "https://cdn.example.com/a.png");
    assert.ok(photoForm[1] instanceof Blob);

    await social.posts.publish({
      targets: [{ account: linkedin, options: { visibility: "connections" } }],
      content: {
        text: "Video",
        media: [
          {
            kind: "video",
            mimeType: "video/mp4",
            source: { kind: "https-url", url: "https://cdn.example.com/v.mp4" },
          },
        ],
      },
    });

    assert.equal(calls[1]?.url.pathname, "/api/upload");
    assert.equal(form(calls[1]).get("video"), "https://cdn.example.com/v.mp4");
    assert.equal(form(calls[1]).get("visibility"), "CONNECTIONS");

    const document = await social.posts.publish({
      targets: [{ account: linkedin }],
      content: {
        text: "Deck",
        media: [
          {
            kind: "document",
            mimeType: "application/pdf",
            filename: "deck.pdf",
            source: { kind: "https-url", url: "https://cdn.example.com/deck.pdf" },
          },
        ],
      },
    });

    assert.equal(document.outcomes[0]?.state, "published");
    assert.equal(calls[2]?.url.pathname, "/api/upload_document");
    assert.equal(form(calls[2]).get("title"), "deck.pdf");
    assert.equal(form(calls[2]).get("description"), "Deck");
    assert.equal(form(calls[2]).get("visibility"), "PUBLIC");
  });

  it("schedules, reads job status, and cancels only a job owned by the same profile and platform", async () => {
    const { calls, fetch } = recorder([
      { success: true, job_id: "job-1", scheduled_date: "2026-10-30T09:00:00Z" },
      { job_id: "job-1", status: "pending", completed: 0, total: 1, results: [] },
      { success: true, job_id: "job-1", profile_username: "brand", platforms: ["x"] },
      { success: true, message: "Job job-1 cancelled and assets deleted." },
      { success: true, job_id: "job-1", profile_username: "someone-else", platforms: ["x"] },
    ]);

    const adapter = uploadPost({ apiKey: "key", fetch, clock });
    const social = createSocial({ backend: adapter, clock });

    const result = await social.posts.publish({
      targets: [{ account: x }],
      content: { text: "Later" },
      schedule: { at: "2026-10-30T09:00:00.000Z", timeZone: "Europe/Madrid" },
    });

    const outcome = result.outcomes[0];

    assert.equal(outcome?.state, "scheduled");
    assert.equal(form(calls[0]).get("scheduled_date"), "2026-10-30T09:00:00.000Z");
    assert.equal(form(calls[0]).get("timezone"), "Europe/Madrid");

    if (outcome?.state !== "scheduled" || outcome.delivery === undefined)
      throw new Error("not scheduled");

    assert.equal((await social.posts.getDelivery(outcome.delivery)).state, "scheduled");
    assert.equal(calls[1]?.url.searchParams.get("job_id"), "job-1");

    assert.deepEqual(await social.posts.cancelScheduled(outcome.job), {
      state: "cancelled",
      backendRecord: "deleted",
    });
    assert.equal(calls[3]?.method, "DELETE");

    await assert.rejects(adapter.posts.cancelScheduled(outcome.job, context), {
      code: "unauthorized",
    });
    assert.equal(calls.length, 5);
  });

  it("reconciles a completed async upload to the native ID from upload history", async () => {
    const { calls, fetch } = recorder([
      {
        request_id: "req-1",
        status: "in_progress",
        results: [{ platform: "x", success: true, message: "Queued" }],
      },
      {
        request_id: "req-1",
        status: "completed",
        results: [{ platform: "x", success: true, message: "Published" }],
      },
      {
        history: [
          {
            request_id: "req-1",
            platform: "x",
            profile_username: "someone-else",
            success: true,
            platform_post_id: "wrong",
          },
          {
            request_id: "req-1",
            platform: "x",
            profile_username: "brand",
            success: true,
            platform_post_id: "1800",
            post_url: "https://x.com/brandx/status/1800",
          },
        ],
      },
      {
        request_id: "req-2",
        status: "completed",
        results: [{ platform: "x", success: false, message: "Rejected" }],
      },
    ]);

    const adapter = uploadPost({ apiKey: "key", fetch, clock });

    const ref = {
      kind: "delivery" as const,
      version: 1 as const,
      backend: "default",
      platform: "x",
      accountId: "brand",
      deliveryId: "request:req-1",
    };

    assert.equal((await adapter.posts.getDelivery(ref, context)).state, "processing");

    const done = await adapter.posts.getDelivery(ref, context);

    assert.equal(done.state, "published");
    assert.equal(done.state === "published" ? done.post.postId : undefined, "1800");
    assert.equal(calls[2]?.url.pathname, "/api/uploadposts/history");

    const failed = await adapter.posts.getDelivery(
      { ...ref, deliveryId: "request:req-2" },
      context,
    );

    assert.equal(failed.state, "failed");

    await assert.rejects(adapter.posts.getDelivery({ ...ref, deliveryId: "opaque" }, context), {
      code: "invalid_input",
    });
  });

  it("maps documented replies and rejects reply shapes Upload-Post does not document", async () => {
    const { calls, fetch } = recorder([
      { success: true, results: { x: { success: true, post_id: "2" } } },
    ]);

    const social = createSocial({ backend: uploadPost({ apiKey: "key", fetch, clock }), clock });

    const parent = (account: ConnectedAccountRef) => ({
      kind: "platform-post" as const,
      version: 1 as const,
      backend: "default",
      platform: account.platform,
      accountId: account.accountId,
      postId: "1",
    });

    await social.posts.publish({
      targets: [{ account: x, replyTo: parent(x) }],
      content: { text: "Reply" },
    });
    assert.equal(form(calls[0]).get("reply_to_id"), "1");

    const blueskyMedia = social.posts.prepare({
      targets: [{ account: bluesky, replyTo: parent(bluesky) }],
      content: {
        text: "Reply",
        media: [
          {
            kind: "image",
            mimeType: "image/png",
            source: { kind: "https-url", url: "https://cdn.example.com/a.png" },
          },
        ],
      },
    });

    assert.ok(blueskyMedia.issues.some((item) => item.code === "reply.use_comments"));

    const linkedinReply = social.posts.prepare({
      targets: [{ account: linkedin, replyTo: parent(linkedin) }],
      content: { text: "Reply" },
    });

    assert.ok(linkedinReply.issues.some((item) => item.code === "reply.use_comments"));
    assert.ok(
      social.posts.prepare({
        targets: [{ account: bluesky, replyTo: parent(bluesky) }],
        content: { text: "Reply" },
      }).ok,
    );
  });

  it("rejects stream sources, alt text, and unmapped options before dispatch", () => {
    const social = createSocial({
      backend: uploadPost({ apiKey: "key", fetch: async () => Response.json({}), clock }),
      clock,
    });

    const codes = social.posts
      .prepare({
        targets: [{ account: bluesky, options: { languages: ["en"] } }],
        content: {
          media: [
            {
              kind: "image",
              mimeType: "image/png",
              filename: "a.png",
              altText: "alt",
              source: { kind: "stream", open: () => new Blob(["a"]).stream(), fingerprint: "a" },
            },
          ],
        },
      })
      .issues.map((item) => item.code);

    assert.ok(codes.includes("upload_post.media_source"));
    assert.ok(codes.includes("media.alt_text_unsupported"));
    assert.ok(codes.includes("options.unmapped"));
  });

  it("removes published posts only on platforms Upload-Post can unpublish", async () => {
    const { calls, fetch } = recorder([{ success: true, message: "deleted" }]);
    const adapter = uploadPost({ apiKey: "key", fetch, clock });

    const post = {
      kind: "platform-post" as const,
      version: 1 as const,
      backend: "default",
      platform: "x",
      accountId: "brand",
      postId: "1700",
    };

    await adapter.posts.removeFromPlatform(post, context);
    assert.equal(calls[0]?.url.pathname, "/api/uploadposts/posts/unpublish");
    assert.equal(calls[0]?.body, JSON.stringify({ platform: "x", user: "brand", post_id: "1700" }));

    await assert.rejects(
      adapter.posts.removeFromPlatform({ ...post, platform: "instagram" }, context),
      {
        code: "unsupported_capability",
      },
    );
  });

  it("verifies timestamped signatures and decodes upload events without the owner email", async () => {
    const payload = {
      event: "upload_completed",
      request_id: "req-1",
      user_email: "owner@example.com",
      profile_username: "brand",
      platform: "x",
      result: { success: true, post_id: "1700" },
      created_at: "2026-10-24T11:59:00Z",
    };

    const body = new TextEncoder().encode(JSON.stringify(payload));
    const timestamp = String(Math.floor(clock().getTime() / 1000));

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("whsec_test"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signed = new TextEncoder().encode(`${timestamp}.${JSON.stringify(payload)}`);

    const signature = Array.from(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, signed)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");

    const adapter = uploadPost({ apiKey: "key", webhookSecret: "whsec_test", clock });

    const headers = new Headers({
      "X-Upload-Post-Signature": `sha256=${signature}`,
      "X-Upload-Post-Timestamp": timestamp,
    });

    assert.deepEqual(await adapter.webhooks.verify({ headers, body }), {
      valid: true,
      method: "hmac",
    });

    const event = await adapter.webhooks.decode({ headers, body }, context);

    assert.equal(event["type"], "publication.updated");
    assert.equal(event["provider"], "upload-post");
    assert.equal(event["backendRecordId"], "req-1");
    assert.deepEqual(event["accountIds"], ["brand"]);
    assert.ok(!JSON.stringify(event).includes("owner@example.com"));

    const stale = new Headers(headers);
    stale.set("X-Upload-Post-Timestamp", String(Number(timestamp) - 3600));

    await assert.rejects(adapter.webhooks.verify({ headers: stale, body }), {
      code: "unauthorized",
    });

    const tampered = new TextEncoder().encode(JSON.stringify({ ...payload, platform: "linkedin" }));

    await assert.rejects(adapter.webhooks.verify({ headers, body: tampered }), {
      code: "unauthorized",
    });
  });

  it("declares Upload-Post capabilities without a standalone media upload", () => {
    const adapter = uploadPost({ apiKey: "key", fetch: async () => Response.json({}) });
    const declarations = adapter.capabilities.capabilities;

    assert.equal(
      declarations.find((item) => item.operation === "media.upload")?.availability,
      "unsupported-by-platform",
    );
    assert.deepEqual(
      declarations.find(
        (item) => item.operation === "posts.publish" && item.platform === "linkedin",
      )?.formats,
      ["text", "image", "video", "carousel", "document"],
    );
    assert.deepEqual(
      declarations
        .filter((item) => item.operation === "posts.removeFromPlatform")
        .map((item) => item.platform),
      ["facebook", "youtube", "x", "linkedin", "threads"],
    );
  });
});
