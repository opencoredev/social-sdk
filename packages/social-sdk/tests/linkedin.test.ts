import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { linkedin } from "../src/platforms/linkedin.js";
import type { JsonObject } from "../src/core/types.js";

/* oxlint-disable anti-slop/require-readable-spacing -- Keep fixture branches compact. */

const nativeContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

const account = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: "urn:li:person:member1",
});

const auth = { accessToken: "secret", author: "urn:li:person:member1" as const };

it("LinkedIn uses explicit version and header-only native IDs without losing integer precision", async () => {
  let calls = 0;

  const social = createSocial({
    backend: linkedin({
      auth,
      apiVersion: "202609",
      fetch: async (input, init) => {
        calls++;
        assert.equal(String(input), "https://api.linkedin.com/rest/posts");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("Linkedin-Version"), "202609");
        assert.equal(headers.get("X-Restli-Protocol-Version"), "2.0.0");
        assert.equal(init?.redirect, "error");
        const body = JSON.parse(String(init?.body));
        assert.equal(body.author, auth.author);
        assert.equal(body.visibility, "PUBLIC");

        return new Response(null, {
          status: 201,
          headers: { "x-restli-id": "urn:li:share:6844785523593134080" },
        });
      },
    }),
  });

  assert.equal(calls, 0);
  const result = await social.posts.publish({ targets: [{ account }], content: { text: "Hello" } });
  assert.equal(result.outcomes[0]?.state, "published");

  if (result.outcomes[0]?.state === "published")
    assert.equal(result.outcomes[0].post.postId, "urn:li:share:6844785523593134080");
  assert.equal(calls, 1);
});

it("LinkedIn does not claim publication without an upstream ID or replay uncertain creates", async () => {
  for (const failure of [false, true]) {
    let calls = 0;

    const social = createSocial({
      backend: linkedin({
        auth,
        apiVersion: "202609",
        fetch: async () => {
          calls++;

          if (failure) throw new Error("private upstream detail");

          return new Response(null, { status: 201 });
        },
      }),
    });

    const result = await social.posts.publish({
      targets: [{ account }],
      content: { text: "Hello" },
    });

    assert.equal(result.outcomes[0]?.state, "unknown");
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes("private upstream detail"));
  }
});

it("LinkedIn refuses unsupported formats/options and cross-author media locally", () => {
  const social = createSocial({ backend: linkedin({ auth, apiVersion: "202609" }) });

  for (const request of [
    {
      targets: [{ account: { ...account, accountId: "urn:li:organization:other" } }],
      content: { text: "Hello" },
    },
    {
      targets: [{ account, options: { visibility: "private" as const } }],
      content: { text: "Hello" },
    },
    { targets: [{ account }], content: { text: "x".repeat(3001) } },
    {
      targets: [{ account }],
      content: {
        media: [
          {
            kind: "image" as const,
            source: {
              kind: "media-ref" as const,
              ref: {
                kind: "media" as const,
                version: 1 as const,
                backend: "other",
                platform: "linkedin",
                accountId: account.accountId,
                mediaId: "urn:li:image:img1",
              },
            },
          },
        ],
      },
    },
  ])
    assert.equal(social.posts.prepare(request).ok, false);
});

it("LinkedIn validates upstream ownership and processing before any post mutation", async () => {
  for (const image of [
    { owner: "urn:li:person:other", status: "AVAILABLE" },
    { owner: auth.author, status: "PROCESSING" },
  ]) {
    const methods: string[] = [];

    const social = createSocial({
      backend: linkedin({
        auth,
        apiVersion: "202609",
        fetch: async (_input, init) => {
          methods.push(init?.method ?? "GET");

          return Response.json(image);
        },
      }),
    });

    const result = await social.posts.publish({
      targets: [{ account }],
      content: {
        text: "image",
        media: [
          {
            kind: "image",
            source: {
              kind: "media-ref",
              ref: {
                kind: "media",
                version: 1,
                backend: "default",
                platform: "linkedin",
                accountId: account.accountId,
                mediaId: "urn:li:image:img1",
              },
            },
          },
        ],
      },
    });

    assert.notEqual(result.outcomes[0]?.state, "published");
    assert.deepEqual(methods, ["GET"]);
  }
});

it("LinkedIn reads social-action counts without inventing missing metrics or measurement times", async () => {
  const post = { ...account, kind: "platform-post" as const, postId: "urn:li:share:123" };

  const social = createSocial({
    backend: linkedin({
      auth,
      apiVersion: "202609",
      fetch: async (input) =>
        String(input).includes("/rest/posts/")
          ? Response.json({ id: post.postId, author: auth.author })
          : Response.json({ target: post.postId, likesSummary: { totalLikes: 3 } }),
    }),
  });

  const metrics = await social.analytics.getPostMetrics(post);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]?.name, "likes");
  assert.equal(metrics[0]?.value, 3);
  assert.equal(metrics[0]?.measuredAt, undefined);
});

it("LinkedIn binds comment replies to their post before dispatching", async () => {
  const comment = {
    kind: "comment" as const,
    version: 1 as const,
    backend: "default",
    platform: "linkedin",
    accountId: auth.author,
    postId: "urn:li:share:123",
    commentId: "urn:li:comment:(urn:li:activity:456,789)",
  };

  const methods: string[] = [];

  const social = createSocial({
    backend: linkedin({
      auth,
      apiVersion: "202609",
      fetch: async (input, init) => {
        methods.push(init?.method ?? "GET");

        if (String(input).includes("/rest/posts/")) return Response.json({ author: auth.author });

        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          assert.equal(body.parentComment, comment.commentId);
          assert.equal(body.object, comment.postId);

          return Response.json({ commentUrn: "urn:li:comment:(urn:li:activity:456,790)" });
        }

        return Response.json({ commentUrn: comment.commentId, object: "urn:li:activity:456" });
      },
    }),
  });

  const reply = await social.comments.reply(comment, { text: "Reply" });
  assert.equal(reply.commentId, "urn:li:comment:(urn:li:activity:456,790)");
  assert.deepEqual(methods, ["GET", "GET", "POST"]);
});

it("LinkedIn escapes Little Text Format commentary and continues after member image 403", async () => {
  const bodies: JsonObject[] = [];
  const social = createSocial({
    backend: linkedin({
      auth,
      apiVersion: "202609",
      fetch: async (input, init) => {
        if (String(input).includes("/rest/images/")) return new Response(null, { status: 403 });
        // SAFETY: the adapter sends a JSON object body for this test request.
        bodies.push(JSON.parse(String(init?.body)) as JsonObject);
        return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:1" } });
      },
    }),
  });
  const result = await social.posts.publish({
    targets: [{ account }],
    content: {
      text: "|{}@[]()<>#\\*_~",
      media: [
        {
          kind: "image",
          source: {
            kind: "media-ref",
            ref: {
              kind: "media",
              version: 1,
              backend: "default",
              platform: "linkedin",
              accountId: auth.author,
              mediaId: "urn:li:image:1",
            },
          },
        },
      ],
    },
  });
  assert.equal(result.outcomes[0]?.state, "published");
  assert.equal(bodies[0]?.commentary, "\\|\\{\\}\\@\\[\\]\\(\\)\\<\\>\\#\\\\\\*\\_\\~");
});

it("LinkedIn native writes use documented poll, reaction, reshare, update, and delete shapes", async () => {
  const calls: { url: string; method: string; body?: JsonObject; headers: Headers }[] = [];
  const adapter = linkedin({
    auth,
    apiVersion: "202609",
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init?.headers),
      });
      return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:99" } });
    },
  });
  const post = "urn:li:share:123";
  const native = adapter.native!;
  const poll = await native.createPoll({
    account,
    text: "Q",
    options: ["A", "B"],
    context: nativeContext,
  });
  await native.react({ account, postId: post, reaction: "LIKE", context: nativeContext });
  const reshared = await native.reshare({ account, postId: post, context: nativeContext });
  await native.updatePost({
    account,
    postId: post,
    body: { commentary: "changed" },
    context: nativeContext,
  });
  await native.deletePost({ account, postId: post, context: nativeContext });
  assert.equal(poll.id, "urn:li:share:99");
  assert.deepEqual(calls[0]?.body?.content, {
    poll: {
      question: "Q",
      options: [{ text: "A" }, { text: "B" }],
      settings: { duration: "THREE_DAYS" },
    },
  });
  assert.equal(
    calls[1]?.url,
    "https://api.linkedin.com/rest/reactions?actor=urn%3Ali%3Aperson%3Amember1",
  );
  assert.deepEqual(calls[2]?.body?.reshareContext, { parent: post });
  assert.equal(reshared.id, "urn:li:share:99");
  assert.equal(calls[3]?.method, "POST");
  assert.equal(calls[3]?.headers.get("X-RestLi-Method"), "PARTIAL_UPDATE");
  assert.deepEqual(calls[3]?.body, { patch: { $set: { commentary: "changed" } } });
  assert.equal(calls[4]?.method, "DELETE");
});

it("LinkedIn removes a platform post through the posts lifecycle", async () => {
  let call: { url: string; method: string; headers: Headers } | undefined;
  const adapter = linkedin({
    auth,
    apiVersion: "202609",
    fetch: async (input, init) => {
      call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      };
      return new Response(null, { status: 204 });
    },
  });
  await adapter.posts!.removeFromPlatform!(
    { ...account, kind: "platform-post", postId: "urn:li:share:1/2" },
    nativeContext,
  );
  assert.equal(call?.url, "https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A1%2F2");
  assert.equal(call?.method, "DELETE");
});

it("LinkedIn rejects a comment whose native parent object differs from the declared post", async () => {
  let posts = 0;

  const comment = {
    kind: "comment" as const,
    version: 1 as const,
    backend: "default",
    platform: "linkedin" as const,
    accountId: auth.author,
    postId: "urn:li:share:123",
    commentId: "urn:li:comment:(urn:li:activity:456,789)",
  };

  const social = createSocial({
    backend: linkedin({
      auth,
      apiVersion: "202609",
      fetch: async (input, init) => {
        if (String(input).includes("/rest/posts/")) return Response.json({ id: comment.postId });

        if (init?.method === "POST") posts++;

        return Response.json({ commentUrn: comment.commentId, object: "urn:li:share:other" });
      },
    }),
  });

  await assert.rejects(social.comments.reply(comment, { text: "reply" }), /parent object/);
  assert.equal(posts, 0);
});

it("LinkedIn normalizes organization follower, page, share, and count statistics", async () => {
  const organization = connectedAccountRef({
    backend: "default",
    platform: "linkedin",
    accountId: "urn:li:organization:123",
  });
  const calls: string[] = [];
  const adapter = linkedin({
    auth: { accessToken: "secret", author: organization.accountId },
    apiVersion: "202609",
    fetch: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("networkSizes")) return Response.json({ firstDegreeSize: 42 });
      if (url.includes("FollowerStatistics"))
        return Response.json({
          elements: [
            {
              organizationalEntity: organization.accountId,
              followerGains: { organicFollowerGain: 4, paidFollowerGain: 1 },
              followerCountsByFunction: [
                { function: "urn:li:function:1", followerCounts: { organicFollowerCount: 9 } },
              ],
            },
          ],
        });
      if (url.includes("PageStatistics"))
        return Response.json({
          elements: [
            {
              organization: organization.accountId,
              totalPageStatistics: { views: { allPageViews: { pageViews: 7 } } },
            },
          ],
        });
      return Response.json({
        elements: [
          { organizationalEntity: organization.accountId, totalShareStatistics: { clickCount: 3 } },
        ],
      });
    },
  });

  assert.deepEqual(
    await adapter.native!.getOrganizationFollowerStatistics({
      account: organization,
      context: nativeContext,
    }),
    [
      {
        organization: organization.accountId,
        organicFollowerGain: 4,
        paidFollowerGain: 1,
        breakdowns: [
          { dimension: "function", value: "urn:li:function:1", organicFollowerCount: 9 },
        ],
      },
    ],
  );
  assert.deepEqual(
    await adapter.native!.getOrganizationPageStatistics({
      account: organization,
      context: nativeContext,
    }),
    [
      {
        organization: organization.accountId,
        views: { allPageViews: 7 },
        clicks: {},
        breakdowns: [],
      },
    ],
  );
  assert.deepEqual(
    await adapter.native!.getOrganizationShareStatistics({
      account: organization,
      interval: { granularity: "DAY", start: 1, end: 2 },
      context: nativeContext,
    }),
    [{ organization: organization.accountId, metrics: { clickCount: 3 } }],
  );
  assert.equal(
    await adapter.native!.getOrganizationFollowerCount({
      account: organization,
      context: nativeContext,
    }),
    42,
  );
  assert.ok(calls.some((url) => url.includes("timeIntervals=")));
});

it("LinkedIn returns empty organization statistics and rejects member analytics", async () => {
  const organization = connectedAccountRef({
    backend: "default",
    platform: "linkedin",
    accountId: "urn:li:organization:123",
  });
  const adapter = linkedin({
    auth: { accessToken: "secret", author: organization.accountId },
    apiVersion: "202609",
    fetch: async () => Response.json({ elements: [] }),
  });
  assert.deepEqual(
    await adapter.native!.getOrganizationFollowerStatistics({
      account: organization,
      context: nativeContext,
    }),
    [],
  );

  const member = connectedAccountRef({
    backend: "default",
    platform: "linkedin",
    accountId: "urn:li:person:member1",
  });
  const memberAdapter = linkedin({
    auth: { accessToken: "secret", author: member.accountId },
    apiVersion: "202609",
  });
  await assert.rejects(
    memberAdapter.native!.getOrganizationPageStatistics({
      account: member,
      context: nativeContext,
    }),
    /organization account, not a member account/,
  );
});

it("LinkedIn uses literal Rest.li timeIntervals and preserves documented time buckets and nested clicks", async () => {
  const organization = connectedAccountRef({
    backend: "default",
    platform: "linkedin",
    accountId: "urn:li:organization:2414183",
  });
  const urls: string[] = [];
  const adapter = linkedin({
    auth: { accessToken: "secret", author: organization.accountId },
    apiVersion: "202609",
    fetch: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("organizationPageStatistics"))
        return Response.json({
          elements: [
            {
              organization: organization.accountId,
              timeRange: { start: 1698796800000, end: 1701388800000 },
              totalPageStatistics: {
                views: {
                  allPageViews: { pageViews: 17786 },
                  uniquePageViews: { uniquePageViews: 42 },
                },
                clicks: {
                  careersPageClicks: { clicks: 12 },
                  mobileCareersPageClicks: { clicks: 3 },
                },
              },
            },
          ],
        });
      if (url.includes("organizationalEntityFollowerStatistics"))
        return Response.json({
          elements: [
            {
              organizationalEntity: organization.accountId,
              timeRange: { start: 1698796800000, end: 1701388800000 },
              followerGains: { organicFollowerGain: 8, paidFollowerGain: 2 },
            },
          ],
        });
      return Response.json({
        elements: [
          {
            organizationalEntity: organization.accountId,
            timeRange: { start: 1698796800000, end: 1701388800000 },
            totalShareStatistics: { clickCount: 3 },
          },
        ],
      });
    },
  });
  const interval = { granularity: "DAY" as const, start: 1698796800000, end: 1701388800000 };
  const followers = await adapter.native!.getOrganizationFollowerStatistics({
    account: organization,
    interval,
    context: nativeContext,
  });
  assert.deepEqual(followers[0]?.interval, interval);
  assert.equal(followers[0]?.organicFollowerGain, 8);
  const page = await adapter.native!.getOrganizationPageStatistics({
    account: organization,
    interval,
    context: nativeContext,
  });
  assert.deepEqual(page[0]?.interval, interval);
  assert.deepEqual(page[0]?.views, { allPageViews: 17786, uniquePageViews: 42 });
  assert.deepEqual(page[0]?.clicks, { careersPageClicks: 12, mobileCareersPageClicks: 3 });
  await adapter.native!.getOrganizationShareStatistics({
    account: organization,
    interval,
    context: nativeContext,
  });
  const expected =
    "https://api.linkedin.com/rest/organizationPageStatistics?q=organization&organization=urn%3Ali%3Aorganization%3A2414183&timeIntervals=(timeRange:(start:1698796800000,end:1701388800000),timeGranularityType:DAY)";
  const expectedInterval =
    "timeIntervals=(timeRange:(start:1698796800000,end:1701388800000),timeGranularityType:DAY)";
  assert.equal(
    urls[0],
    `https://api.linkedin.com/rest/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=urn%3Ali%3Aorganization%3A2414183&${expectedInterval}`,
  );
  assert.equal(urls[1], expected);
  assert.equal(
    urls[2],
    `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=urn%3Ali%3Aorganization%3A2414183&${expectedInterval}`,
  );
});
