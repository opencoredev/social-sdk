import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { linkedin } from "../src/platforms/linkedin.js";

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

        return Response.json({ commentUrn: comment.commentId });
      },
    }),
  });

  const reply = await social.comments.reply(comment, { text: "Reply" });
  assert.equal(reply.commentId, "urn:li:comment:(urn:li:activity:456,790)");
  assert.deepEqual(methods, ["GET", "GET", "POST"]);
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
