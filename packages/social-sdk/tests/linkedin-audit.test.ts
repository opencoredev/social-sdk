import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { linkedin } from "../src/platforms/linkedin.js";
import type { LinkedInTimeInterval } from "../src/platforms/linkedin.js";
import type { CommentRef, PlatformPostRef } from "../src/core/types.js";
import { SocialError } from "../src/core/errors.js";
import { HttpError } from "../src/transport/http.js";

const context = {
  backendInstance: "default",
  correlationId: "linkedin-audit",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

const author = "urn:li:organization:2414183";

const account = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: author,
});

const post: PlatformPostRef = {
  ...account,
  kind: "platform-post",
  version: 1,
  postId: "urn:li:ugcPost:7096760097833435136",
};

const adapterWith = (fetch: typeof globalThis.fetch) =>
  linkedin({ auth: { accessToken: "fixture", author }, apiVersion: "202609", fetch });

it("LinkedIn replies accept activity, share and official ugcPost comment roots with numeric lookup", async () => {
  for (const root of [
    "urn:li:activity:7096760097833435136",
    "urn:li:share:7096760097833435136",
    post.postId,
  ]) {
    const comment: CommentRef = {
      ...post,
      kind: "comment",
      commentId: `urn:li:comment:(${root},7096760097833435137)`,
    };

    const calls: string[] = [];

    const adapter = adapterWith(async (input, init) => {
      const url = String(input);
      calls.push(url);

      if (url.includes("/rest/posts/")) return Response.json({ id: post.postId });

      if (init?.method === "POST")
        return Response.json({ commentUrn: `urn:li:comment:(${root},7096760097833435138)` });
      assert.ok(url.endsWith("/comments/7096760097833435137"));

      return Response.json({ commentUrn: comment.commentId, object: root });
    });

    const reply = await adapter.comments!.reply(comment, { text: "Reply" }, context);
    assert.equal(reply.commentId, `urn:li:comment:(${root},7096760097833435138)`);
    assert.equal(calls.length, 3);
  }
});

it("LinkedIn treats collection 404 as empty only after successful post preflight", async () => {
  for (const status of [200, 403, 404]) {
    let calls = 0;

    const adapter = adapterWith(async (input) => {
      calls++;

      return String(input).includes("/rest/posts/")
        ? Response.json({ id: post.postId, author }, { status })
        : new Response(null, { status: 404 });
    });

    if (status === 200) {
      assert.deepEqual(await adapter.comments!.list(post, {}, context), { items: [] });
      assert.equal(calls, 2);
    } else {
      await assert.rejects(
        adapter.comments!.list(post, {}, context),
        (error) =>
          error instanceof SocialError &&
          error.code === (status === 403 ? "missing_permission" : "not_found"),
      );
      assert.equal(calls, 1);
    }
  }
});

it("LinkedIn page statistics preserve dual view fields and dimensional custom-button clicks", async () => {
  const adapter = adapterWith(async () =>
    Response.json({
      elements: [
        {
          organization: author,
          totalPageStatistics: {
            views: {
              allPageViews: { pageViews: 42, uniquePageViews: 17 },
              uniqueOnly: { uniquePageViews: 9 },
            },
            clicks: {
              desktopCustomButtonClickCounts: [
                { customButtonType: "VIEW_WEBSITE", deviceType: "DESKTOP", clickCount: 5 },
              ],
            },
          },
        },
      ],
    }),
  );

  const rows = await adapter.native!.getOrganizationPageStatistics({ account, context });
  assert.deepEqual(rows[0]?.views, {
    allPageViews: 42,
    "allPageViews.uniquePageViews": 17,
    "uniqueOnly.uniquePageViews": 9,
  });
  assert.deepEqual(rows[0]?.clicks, { "desktopCustomButtonClickCounts[0].clickCount": 5 });
  assert.deepEqual(rows[0]?.rawClicks, {
    desktopCustomButtonClickCounts: [
      { customButtonType: "VIEW_WEBSITE", deviceType: "DESKTOP", clickCount: 5 },
    ],
  });
});

it("LinkedIn organizationAnalytics forwards accepted intervals and rejects unsupported filters", async () => {
  const urls: string[] = [];

  const adapter = adapterWith(async (input) => {
    urls.push(String(input));

    return Response.json({ elements: [] });
  });

  await adapter.native!.organizationAnalytics({
    account,
    context,
    query: { timeIntervals: { timeGranularityType: "DAY", timeRange: { start: 100, end: 200 } } },
  });
  assert.ok(
    urls[0]?.includes("timeIntervals=(timeRange:(start:100,end:200),timeGranularityType:DAY)"),
  );

  for (const query of [
    { shares: [post.postId] },
    { q: "other" },
    { timeIntervals: { timeGranularityType: "WEEK", timeRange: { start: 100 } } },
  ])
    await assert.rejects(adapter.native!.organizationAnalytics({ account, context, query }), {
      code: "invalid_input",
    });
  assert.equal(urls.length, 1);
});

it("LinkedIn rejects legacy share WEEK before requests and retains follower WEEK", async () => {
  let calls = 0;

  const adapter = adapterWith(async () => {
    calls++;

    return Response.json({ elements: [] });
  });

  const interval: LinkedInTimeInterval = { granularity: "WEEK", start: 100 };
  // Exercise runtime validation through the legacy JsonObject entry point.
  await assert.rejects(
    adapter.native!.organizationAnalytics({
      account,
      context,
      query: {
        timeIntervals: { timeGranularityType: interval.granularity, timeRange: { start: 100 } },
      },
    }),
    { code: "invalid_input" },
  );
  assert.equal(calls, 0);
  await adapter.native!.getOrganizationFollowerStatistics({ account, context, interval });
  assert.equal(calls, 1);
});

it("LinkedIn image size validation happens before initialization and respects the elapsed budget", async () => {
  let calls = 0;

  const adapter = adapterWith(async (input, init) => {
    calls++;

    if (String(input).includes("initializeUpload"))
      return Response.json({
        value: { image: "urn:li:image:fixture", uploadUrl: "https://www.linkedin.com/upload" },
      });

    return new Promise<Response>((resolve, reject) => {
      setTimeout(() => resolve(new Response(null, { status: 200 })), 150);
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  });

  for (const byteSize of [0, -1, 20 * 1024 * 1024 + 1])
    await assert.rejects(
      adapter.media!.upload(
        {
          kind: "image",
          mimeType: "image/png",
          byteSize,
          source: { kind: "blob", blob: new Blob(["x"]), fingerprint: "fixture" },
        },
        account,
        context,
      ),
      { code: "invalid_input" },
    );
  assert.equal(calls, 0);
  await assert.rejects(
    adapter.media!.upload(
      {
        kind: "image",
        mimeType: "image/png",
        source: { kind: "blob", blob: new Blob(["x"]), fingerprint: "fixture" },
      },
      account,
      { ...context, retryBudget: { maxAttempts: 1, maxElapsedMs: 30 } },
    ),
    (error) => error instanceof HttpError && error.kind === "timeout",
  );
});

it("LinkedIn single-image preparation applies the inclusive 4086-character alt-text limit", () => {
  const social = createSocial({ backend: adapterWith(async () => Response.json({})) });

  for (const length of [4086, 4087]) {
    const result = social.posts.prepare({
      targets: [{ account }],
      content: {
        media: [
          {
            kind: "image",
            altText: "x".repeat(length),
            source: {
              kind: "media-ref",
              ref: { ...account, kind: "media", version: 1, mediaId: "urn:li:image:fixture" },
            },
          },
        ],
      },
    });

    assert.equal(result.ok, length === 4086);
  }
});

it("LinkedIn declares author-specific feed grants and unimplemented adapter surfaces", () => {
  for (const author of ["urn:li:person:fixture", "urn:li:organization:2414183"]) {
    const adapter = linkedin({
      auth: {
        accessToken: "fixture",
        author:
          author === "urn:li:person:fixture"
            ? "urn:li:person:fixture"
            : "urn:li:organization:2414183",
      },
      apiVersion: "202609",
    });

    const scope = author.startsWith("urn:li:person:") ? "member" : "organization";

    for (const operation of [
      "comments.read",
      "comments.write",
      "comments.delete",
      "reactions.write",
      "analytics.read",
    ]) {
      const entry = adapter.capabilities.capabilities.find(
        (entry) => entry.operation === operation,
      );

      assert.deepEqual(entry?.requiredScopes, [
        `${operation === "comments.read" || operation === "analytics.read" ? "r" : "w"}_${scope}_social_feed`,
        ...(["comments.read", "comments.write", "analytics.read"].includes(operation)
          ? [`r_${scope}_social`]
          : []),
        ...(operation === "comments.write" ? [`r_${scope}_social_feed`] : []),
      ]);
    }

    for (const operation of ["articles.create", "profile.update", "messages.write"])
      assert.equal(
        adapter.capabilities.capabilities.find((entry) => entry.operation === operation)
          ?.availability,
        "not-implemented-by-adapter",
      );
    assert.deepEqual(
      adapter.capabilities.capabilities.find((entry) => entry.operation === "posts.publish")
        ?.requiredScopes,
      [`w_${scope}_social`],
    );
  }
});
