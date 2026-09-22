import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });

const auth = { userId: "u1", accessToken: "test" };

it("X image publishing uses OAuth2 v2 media upload and preserves reply settings", async () => {
  const methods: string[] = [];

  const social = createSocial({
    backend: x({
      auth,
      fetch: async (input, init) => {
        assert.equal(init?.redirect, "error");
        const url = new URL(String(input));
        methods.push(url.pathname);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test");

        if (url.pathname === "/2/media/upload") {
          assert.ok(init?.body instanceof FormData);
          assert.equal(init.body.get("media_category"), "tweet_image");

          return Response.json({ data: { id: "media1" } });
        }

        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.media, { media_ids: ["media1"] });
        assert.equal(body.reply_settings, "following");

        return Response.json({ data: { id: "post1" } });
      },
    }),
  });

  const result = await social.posts.publish({
    targets: [{ account, options: { replySettings: "following" } }],
    content: {
      text: "Image",
      media: [
        {
          kind: "image",
          mimeType: "image/png",
          filename: "image.png",
          source: {
            kind: "blob",
            blob: new Blob([new Uint8Array(100)], { type: "image/png" }),
            fingerprint: "image1",
          },
        },
      ],
    },
  });

  assert.equal(result.outcomes[0]?.state, "published");
  assert.deepEqual(methods, ["/2/media/upload", "/2/tweets"]);
});

it("X local validation counts weighted Unicode and URLs without network access", () => {
  const social = createSocial({ backend: x({ auth }) });

  for (const text of ["a".repeat(281), "界".repeat(141)])
    assert.equal(social.posts.prepare({ targets: [{ account }], content: { text } }).ok, false);

  for (const text of ["界".repeat(140), "https://example.com/" + "a".repeat(300), "👨‍👩‍👧‍👦".repeat(100)])
    assert.equal(social.posts.prepare({ targets: [{ account }], content: { text } }).ok, true);
  assert.equal(
    social.posts.prepare({
      targets: [{ account: { ...account, accountId: "other" } }],
      content: { text: "Hello" },
    }).ok,
    false,
  );
});

it("X lost create responses remain unknown and never replay", async () => {
  let calls = 0;

  const social = createSocial({
    backend: x({
      auth,
      fetch: async () => {
        calls++;
        throw new Error("private");
      },
    }),
  });

  const result = await social.posts.publish({ targets: [{ account }], content: { text: "Hello" } });
  assert.equal(result.outcomes[0]?.state, "unknown");
  assert.equal(calls, 1);
});

it("X validates upstream account ownership and exposes only returned metrics", async () => {
  const social = createSocial({
    backend: x({
      auth,
      fetch: async (input) =>
        String(input).includes("/users/me")
          ? Response.json({
              data: { id: "u1", name: "User", username: "user", token: "do-not-return" },
            })
          : Response.json({
              data: { id: "post1", author_id: "u1", public_metrics: { like_count: 0 } },
            }),
    }),
  });

  const accounts = await social.accounts.list();
  assert.ok(!JSON.stringify(accounts).includes("do-not-return"));

  const metrics = await social.analytics.getPostMetrics({
    ...account,
    kind: "platform-post",
    postId: "post1",
  });

  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]?.value, 0);
  assert.equal(metrics[0]?.measuredAt, undefined);
});

it("X validates the declared reply parent conversation before creating a reply", async () => {
  const methods: string[] = [];

  const social = createSocial({
    backend: x({
      auth,
      fetch: async (input, init) => {
        methods.push(init?.method ?? "GET");
        const id = new URL(String(input)).pathname.split("/").at(-1);

        return Response.json({
          data: { id, conversation_id: id === "parent2" ? "other-root" : "root1" },
        });
      },
    }),
  });

  await assert.rejects(
    social.comments.reply(
      {
        kind: "comment",
        version: 1,
        backend: "default",
        platform: "x",
        accountId: "u1",
        postId: "root1",
        commentId: "parent2",
      },
      { text: "reply" },
    ),
    /conversation/,
  );
  assert.deepEqual(methods, ["GET", "GET"]);
});
