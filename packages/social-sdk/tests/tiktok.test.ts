import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { tiktok } from "../src/platforms/tiktok.js";
import type { AdapterOperationContext, PublishRequest } from "../src/core/types.js";

const account = connectedAccountRef({
  backend: "default",
  platform: "tiktok",
  accountId: "creator1",
});

const creator = {
  accountId: "creator1",
  backend: "default",
  username: "demo",
  nickname: "Demo",
  fetchedAt: "2026-09-19T00:00:00Z",
  privacyLevels: ["SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxVideoDurationSeconds: 60,
};

const request: PublishRequest = {
  targets: [
    {
      account,
      options: {
        privacy: "SELF_ONLY",
        consentGiven: true,
        disableComments: true,
        disableDuet: true,
        disableStitch: true,
        brandedContent: false,
        ownBrand: false,
        aiGenerated: false,
        draft: false,
        creatorInfo: creator,
      },
    },
  ],
  content: {
    text: "caption",
    media: [
      {
        kind: "video",
        mimeType: "video/mp4",
        durationSeconds: 30,
        source: { kind: "https-url", url: "https://media.example.test/video.mp4" },
      },
    ],
  },
};

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
const response = (data: unknown) => Response.json({ data, error: { code: "ok" } });

it("TikTok validates consent and verified origins locally before any transfer", () => {
  let calls = 0;

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async () => {
      calls++;
      throw new Error("must not run");
    },
  });

  const social = createSocial({ backend: adapter });
  assert.ok(social.posts.prepare(request).ok);
  assert.equal(
    social.posts.prepare({
      ...request,
      targets: [{ account, options: { privacy: "SELF_ONLY", consentGiven: false } }],
    }).ok,
    false,
  );
  assert.equal(
    social.posts.prepare({
      ...request,
      content: {
        media: [
          {
            kind: "video",
            source: { kind: "https-url", url: "https://unverified.example.test/v.mp4" },
          },
        ],
      },
    }).ok,
    false,
  );
  assert.equal(calls, 0);
});

it("TikTok queries current creator restrictions and preserves explicit privacy/disclosures", async () => {
  const calls: string[] = [];

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);

      if (path.includes("creator_info"))
        return response({
          creator_username: "demo",
          creator_nickname: "Demo",
          privacy_level_options: ["SELF_ONLY"],
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: false,
          max_video_post_duration_sec: 60,
        });
      const body = JSON.parse(String(init?.body));
      assert.equal(body.post_info.privacy_level, "SELF_ONLY");
      assert.equal(body.post_info.brand_content_toggle, false);
      assert.equal(body.post_info.disable_comment, true);
      assert.equal(body.source_info.source, "PULL_FROM_URL");

      return response({ publish_id: "publish1" });
    },
  });

  const result = await createSocial({ backend: adapter }).posts.publish(request);
  assert.equal(result.outcomes[0]?.state, "accepted");
  assert.equal(result.outcomes[0]?.delivery?.deliveryId, "publish1");
  assert.deepEqual(calls, ["/v2/post/publish/creator_info/query/", "/v2/post/publish/video/init/"]);
});

it("TikTok refuses changed creator privacy before initializing a post", async () => {
  let calls = 0;

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async () => {
      calls++;

      return response({
        creator_username: "demo",
        creator_nickname: "Demo",
        privacy_level_options: ["PUBLIC_TO_EVERYONE"],
      });
    },
  });

  const result = await createSocial({ backend: adapter }).posts.publish(request);
  assert.equal(result.outcomes[0]?.state, "failed");
  assert.equal(calls, 1);
});

it("TikTok draft inbox remains accepted and large native IDs retain their exact decimal digits", async () => {
  let state = "SEND_TO_USER_INBOX";

  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: [],
    fetch: async () =>
      new Response(
        `{"error":{"code":"ok"},"data":{"status":"${state}","publicaly_available_post_id":[9007199254740993]}}`,
      ),
  });

  const ref = {
    kind: "delivery" as const,
    version: 1 as const,
    backend: "default",
    platform: "tiktok",
    accountId: "creator1",
    deliveryId: "p1",
  };

  assert.equal((await adapter.posts.getDelivery(ref, context)).state, "accepted");
  state = "PUBLISH_COMPLETE";
  const result = await adapter.posts.getDelivery(ref, context);
  assert.equal(result.state, "published");

  if (result.state === "published") assert.equal(result.post.postId, "9007199254740993");
});

it("TikTok photo publishing keeps cover order and disables unrequested added music", async () => {
  const adapter = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: async (input, init) => {
      if (String(input).includes("creator_info"))
        return response({
          creator_username: "demo",
          creator_nickname: "Demo",
          privacy_level_options: ["SELF_ONLY"],
        });
      const body = JSON.parse(String(init?.body));
      assert.equal(body.media_type, "PHOTO");
      assert.equal(body.source_info.photo_cover_index, 1);
      assert.equal(body.post_info.auto_add_music, false);
      assert.equal(body.is_aigc, false);
      assert.equal("is_aigc" in body.post_info, false);
      assert.equal("disable_duet" in body.post_info, false);
      assert.equal("disable_stitch" in body.post_info, false);
      assert.deepEqual(body.source_info.photo_images, [
        "https://media.example.test/1.jpg",
        "https://media.example.test/2.jpg",
      ]);

      return response({ publish_id: "photo1" });
    },
  });

  const base = request.targets[0];
  assert.ok(base);

  const result = await createSocial({ backend: adapter }).posts.publish({
    targets: [{ ...base, options: { ...base.options, photoCoverIndex: 1 } }],
    content: {
      text: "photos",
      media: [1, 2].map((index) => ({
        kind: "image",
        mimeType: "image/jpeg",
        source: { kind: "https-url", url: `https://media.example.test/${index}.jpg` },
      })),
    },
  });

  assert.equal(result.outcomes[0]?.state, "accepted");
});
