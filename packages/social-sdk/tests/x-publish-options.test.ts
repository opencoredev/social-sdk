import { it } from "node:test";
import assert from "node:assert/strict";
import {
  createSocial,
  connectedAccountRef,
  platformPostRef,
  type AdapterOperationContext,
  type XPublishOptions,
} from "../src/index.js";
import type { JsonValue } from "../src/core/types.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const auth = { userId: "11", accessToken: "test" };

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "x-options",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

interface Captured {
  readonly path: string;
  readonly body: JsonValue | undefined;
  readonly form?: FormData;
}

function recorder() {
  const requests: Captured[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));

    if (init?.body instanceof FormData) {
      requests.push({ path: url.pathname, body: undefined, form: init.body });

      return Response.json({ data: { id: "900" } });
    }

    requests.push({
      path: url.pathname,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    if (url.pathname === "/2/media/upload/initialize")
      return Response.json({ data: { id: "901" } });

    if (url.pathname.endsWith("/finalize")) return Response.json({ data: { id: "901" } });

    return Response.json({ data: { id: "1001", text: "ok" } });
  };

  return { requests, fetch };
}

const image = (mimeType = "image/png") => ({
  kind: "image" as const,
  mimeType,
  filename: "card",
  source: {
    kind: "blob" as const,
    blob: new Blob([new Uint8Array(32)], { type: mimeType }),
    fingerprint: "image",
  },
});

function postBody(requests: readonly Captured[]): JsonValue | undefined {
  return requests.find((request) => request.path === "/2/tweets")?.body;
}

it("sends Community, disclosure, geo, deep-link and card fields on POST /2/tweets [feature:x.publish.community]", async () => {
  const { requests, fetch } = recorder();
  const social = createSocial({ backend: x({ auth, fetch }) });

  const options: XPublishOptions = {
    communityId: "1500000000000000001",
    shareWithFollowers: true,
    paidPartnership: true,
    madeWithAi: true,
    placeId: "5a110d312052166f",
    directMessageDeepLink: "https://x.com/messages/compose?recipient_id=11",
    cardUri: "card://1234567890",
    quotedPostId: "1700000000000000000",
  };

  const result = await social.posts.publish({
    targets: [{ account, options }],
    content: { text: "Community update" },
  });

  assert.equal(result.outcomes[0]?.state, "published");
  assert.deepEqual(postBody(requests), {
    text: "Community update",
    community_id: "1500000000000000001",
    share_with_followers: true,
    paid_partnership: true,
    made_with_ai: true,
    geo: { place_id: "5a110d312052166f" },
    direct_message_deep_link: "https://x.com/messages/compose?recipient_id=11",
    card_uri: "card://1234567890",
    quote_tweet_id: "1700000000000000000",
  });
});

it("restricts a post with for_super_followers_only and subscribers reply settings [feature:x.publish.super_followers]", async () => {
  const { requests, fetch } = recorder();
  const social = createSocial({ backend: x({ auth, fetch }) });

  await social.posts.publish({
    targets: [{ account, options: { forSuperFollowersOnly: true, replySettings: "subscribers" } }],
    content: { text: "Subscribers only" },
  });

  assert.deepEqual(postBody(requests), {
    text: "Subscribers only",
    reply_settings: "subscribers",
    for_super_followers_only: true,
  });

  const verified = recorder();
  await createSocial({ backend: x({ auth, fetch: verified.fetch }) }).posts.publish({
    targets: [{ account, options: { replySettings: "verified" } }],
    content: { text: "Verified replies" },
  });
  assert.deepEqual(postBody(verified.requests), {
    text: "Verified replies",
    reply_settings: "verified",
  });
});

it("merges media card fields next to media_ids [feature:x.media.post_card] [feature:x.media.tagged_users]", async () => {
  const { requests, fetch } = recorder();
  const social = createSocial({ backend: x({ auth, fetch }) });

  const result = await social.posts.publish({
    targets: [
      {
        account,
        options: {
          mediaTitle: "Launch",
          mediaDescription: "Product walkthrough",
          previewMediaId: "902",
          embeddable: true,
          taggedUserIds: ["12", "13"],
          callToActions: {
            visitSite: { url: "https://example.com/launch" },
            appInstall: { appStoreId: "333903271", playStoreId: "com.example.app" },
          },
        },
      },
    ],
    content: { text: "Watch", media: [image()] },
  });

  assert.equal(result.outcomes[0]?.state, "published");
  assert.deepEqual(postBody(requests), {
    text: "Watch",
    media: {
      media_ids: ["900"],
      title: "Launch",
      description: "Product walkthrough",
      preview_media_id: "902",
      embeddable: true,
      tagged_user_ids: ["12", "13"],
      call_to_actions: {
        visit_site: { url: "https://example.com/launch" },
        app_install: { app_store_id: "333903271", play_store_id: "com.example.app" },
      },
    },
  });
});

it("sends reply.exclude_reply_user_ids on a reply [feature:x.publish.exclude_reply_users]", async () => {
  const { requests, fetch } = recorder();
  const social = createSocial({ backend: x({ auth, fetch }) });

  await social.posts.publish({
    targets: [
      {
        account,
        replyTo: platformPostRef({
          backend: "default",
          platform: "x",
          accountId: "11",
          postId: "1600000000000000000",
        }),
        options: { excludeReplyUserIds: ["14", "15"] },
      },
    ],
    content: { text: "Thanks" },
  });

  assert.deepEqual(postBody(requests), {
    text: "Thanks",
    reply: { in_reply_to_tweet_id: "1600000000000000000", exclude_reply_user_ids: ["14", "15"] },
  });
});

it("sends reply.auto_populate_reply_metadata on a reply", async () => {
  const { requests, fetch } = recorder();
  const social = createSocial({ backend: x({ auth, fetch }) });

  await social.posts.publish({
    targets: [
      {
        account,
        replyTo: platformPostRef({
          backend: "default",
          platform: "x",
          accountId: "11",
          postId: "1600000000000000000",
        }),
        options: { autoPopulateReplyMetadata: true },
      },
    ],
    content: { text: "Thanks" },
  });

  assert.deepEqual(postBody(requests), {
    text: "Thanks",
    reply: { in_reply_to_tweet_id: "1600000000000000000", auto_populate_reply_metadata: true },
  });
});

it("rejects option misuse before any request", () => {
  let calls = 0;

  const social = createSocial({
    backend: x({
      auth,
      fetch: async () => {
        calls++;

        return Response.json({});
      },
    }),
  });

  const invalid: readonly [XPublishOptions, string][] = [
    [{ mediaTitle: "No media" }, "x.media_options"],
    [{ excludeReplyUserIds: ["14"] }, "x.options"],
    [{ autoPopulateReplyMetadata: true }, "x.options"],
    [{ taggedUserIds: Array.from({ length: 11 }, (_, index) => String(index + 1)) }, "x.options"],
    [{ directMessageDeepLink: "http://insecure.example" }, "x.options"],
    [{ communityId: "community" }, "x.options"],
    [{ callToActions: { watchNow: { url: "ftp://example.com" } } }, "x.options"],
  ];

  for (const [options, code] of invalid) {
    const prepared = social.posts.prepare({
      targets: [{ account, options }],
      content: { text: "Check" },
    });

    assert.equal(prepared.ok, false, JSON.stringify(options));

    if (!prepared.ok)
      assert.ok(
        prepared.issues.some((issue) => issue.code === code),
        JSON.stringify(prepared.issues),
      );
  }

  assert.equal(calls, 0);
});

it("allows 25_000 weighted characters only with longform [feature:x.publish.longform]", async () => {
  const { requests, fetch } = recorder();
  const social = createSocial({ backend: x({ auth, fetch }) });

  const long = "a".repeat(25_000);

  assert.equal(social.posts.prepare({ targets: [{ account }], content: { text: long } }).ok, false);
  assert.equal(
    social.posts.prepare({
      targets: [{ account, options: { longform: true } }],
      content: { text: "a".repeat(25_001) },
    }).ok,
    false,
  );

  const result = await social.posts.publish({
    targets: [{ account, options: { longform: true } }],
    content: { text: long },
  });

  assert.equal(result.outcomes[0]?.state, "published");
  assert.deepEqual(postBody(requests), { text: long });
});

it("uploads image/webp through the simple media upload [feature:x.publish.images]", async () => {
  const { requests, fetch } = recorder();
  const social = createSocial({ backend: x({ auth, fetch }) });

  const result = await social.posts.publish({
    targets: [{ account }],
    content: { text: "WEBP", media: [image("image/webp")] },
  });

  assert.equal(result.outcomes[0]?.state, "published");

  const upload = requests[0]?.form?.get("media");
  assert.ok(upload instanceof Blob);
  assert.equal(upload.type, "image/webp");
  assert.equal(requests[0]?.form?.get("media_category"), "tweet_image");
});

it("initializes QuickTime and WebM uploads with their media_type [feature:x.publish.video]", async () => {
  for (const mimeType of ["video/quicktime", "video/webm"] as const) {
    const { requests, fetch } = recorder();
    const adapter = x({ auth, fetch });
    assert.ok(adapter.native);

    const uploaded = await adapter.native.uploadVideo({
      account,
      video: new Blob([new Uint8Array(64)], { type: mimeType }),
      mimeType,
      context,
    });

    assert.equal(uploaded.mediaId, "901");
    assert.deepEqual(requests[0], {
      path: "/2/media/upload/initialize",
      body: { media_category: "tweet_video", media_type: mimeType, total_bytes: 64 },
    });
  }
});

it("quotes a post with quote_tweet_id [feature:x.publish.quote]", async () => {
  const { requests, fetch } = recorder();
  const adapter = x({ auth, fetch });
  assert.ok(adapter.native);

  const result = await adapter.native.quote({
    account,
    text: "Worth reading",
    quotedPostId: "1700000000000000000",
    context,
  });

  assert.deepEqual(result, { data: { id: "1001", text: "ok" } });
  assert.deepEqual(requests, [
    {
      path: "/2/tweets",
      body: { text: "Worth reading", quote_tweet_id: "1700000000000000000" },
    },
  ]);
});
