import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { postForMe } from "../src/cloud/post-for-me.js";
import { isJsonValue } from "../src/transport/json.js";
import { object } from "../src/transport/validation.js";
import type {
  AdapterOperationContext,
  JsonObject,
  JsonValue,
  MediaAttachment,
} from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-11-04T12:00:00Z");

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly body?: JsonObject;
}

/** A Post for Me adapter whose fake fetch records the full URL, so repeated parameters survive. */
function fake(answer: JsonValue) {
  const calls: Call[] = [];

  const adapter = postForMe({
    apiKey: "test",
    clock,
    fetch: async (input, init) => {
      const parsed: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));

      const call: Call = { method: init?.method ?? "GET", url: new URL(String(input)) };

      calls.push(isJsonValue(parsed) ? { ...call, body: object(parsed) } : call);

      return Response.json(answer);
    },
  });

  return { adapter, calls };
}

const account = (platform: string, accountId = "spc_1") =>
  connectedAccountRef({ backend: "default", platform, accountId });

const image = (name: string): MediaAttachment => ({
  kind: "image",
  mimeType: "image/png",
  source: { kind: "https-url", url: `https://cdn.example.test/${name}.png` },
});

const video: MediaAttachment = {
  kind: "video",
  mimeType: "video/mp4",
  source: { kind: "https-url", url: "https://cdn.example.test/clip.mp4" },
};

it("previews several accounts with per-account caption, media and options [feature:post-for-me.publish.per_target_overrides]", async () => {
  const { adapter, calls } = fake([
    {
      caption: "Shared",
      platform: "instagram",
      social_account_id: "spc_ig",
      media: [{ url: "https://cdn.example.test/a.png" }],
    },
    {
      caption: "X caption",
      platform: "x",
      social_account_id: "spc_x",
      media: [{ url: "https://cdn.example.test/b.png", alt_text: null }],
    },
  ]);

  const result = await adapter.native.previewPosts(
    {
      content: { text: "Shared", media: [image("a")] },
      targets: [
        { account: account("instagram", "spc_ig") },
        {
          account: account("x", "spc_x"),
          content: { text: "X caption", media: [image("b")] },
          options: {
            quotePostId: "1234567890",
            replySettings: "following",
            mediaOptions: [{ skipProcessing: true }],
          },
        },
      ],
    },
    context,
  );

  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url.pathname, "/v1/social-post-previews");
  assert.deepEqual(calls[0]?.body, {
    caption: "Shared",
    preview_social_accounts: [
      { id: "spc_ig", platform: "instagram" },
      { id: "spc_x", platform: "x" },
    ],
    media: [{ url: "https://cdn.example.test/a.png" }],
    account_configurations: [
      {
        social_account_id: "spc_x",
        configuration: {
          caption: "X caption",
          media: [{ url: "https://cdn.example.test/b.png", skip_processing: true }],
          quote_tweet_id: "1234567890",
          reply_settings: "following",
        },
      },
    ],
  });
  assert.deepEqual(
    result.previews.map((preview) => preview.media),
    [["https://cdn.example.test/a.png"], ["https://cdn.example.test/b.png"]],
  );
  assert.deepEqual(result.localIssues, []);

  await assert.rejects(
    adapter.native.previewPosts({ content: { text: "x" }, targets: [] }, context),
    {
      code: "invalid_input",
    },
  );
  assert.equal(calls.length, 1);
});

it("sends skip_processing per media item in media order", async () => {
  let body: JsonObject | undefined;

  const social = createSocial({
    clock,
    backend: postForMe({
      apiKey: "test",
      clock,
      fetch: async (_input, init) => {
        const parsed: unknown = JSON.parse(String(init?.body));

        assert.ok(isJsonValue(parsed));
        body = object(parsed);

        return Response.json({ id: "sp_1", status: "scheduled" });
      },
    }),
  });

  await social.posts.publish({
    content: { text: "Two clips", media: [video, image("still")] },
    targets: [
      {
        account: account("facebook"),
        options: { mediaOptions: [{ skipProcessing: true }, {}] },
      },
    ],
    schedule: { at: "2026-11-05T09:00:00.000Z" },
  });

  assert.deepEqual(body?.["media"], [
    { url: "https://cdn.example.test/clip.mp4", skip_processing: true },
    { url: "https://cdn.example.test/still.png" },
  ]);
});

it("rejects mediaOptions that Post for Me cannot map", () => {
  const social = createSocial({ clock, backend: postForMe({ apiKey: "test", clock }) });

  const codes = (options: JsonObject, media: readonly MediaAttachment[]) =>
    social.posts
      .prepare({
        content: { text: "Clip", media },
        targets: [{ account: account("tiktok"), options }],
      })
      .issues.filter((issue) => issue.code === "media.options").length;

  assert.equal(codes({ mediaOptions: [{ skipProcessing: "yes" }] }, [video]), 1);
  assert.equal(
    codes({ mediaOptions: [{ subtitles: [{ url: "https://x.test/a.srt", language: "en" }] }] }, [
      video,
    ]),
    1,
  );
  assert.equal(codes({ mediaOptions: [{}, {}] }, [video]), 1);
  assert.equal(codes({ mediaOptions: [{ skipProcessing: false }] }, [video]), 0);
});

it("filters the account feed by social_post_id, external_post_id and platform_post_id", async () => {
  const { adapter, calls } = fake({
    data: [
      {
        social_post_id: "sp_1",
        external_post_id: "idem_1",
        social_post_result_id: "spr_1",
        platform_post_id: "native_1",
        social_account_id: "spc_1",
        platform_url: "https://www.instagram.com/p/abc/",
        caption: "Hello",
        metrics: { likes: 3 },
        platform_data: { private: "dropped" },
      },
      { social_post_id: "sp_2", social_account_id: "spc_other" },
    ],
    meta: { cursor: "c2", has_more: true },
  });

  const result = await adapter.native.findFeedPosts(
    {
      account: account("instagram"),
      socialPostIds: ["sp_1", "sp_9"],
      externalPostIds: ["idem_1"],
      metrics: true,
    },
    context,
  );

  const url = calls[0]?.url;

  assert.equal(url?.pathname, "/v1/social-account-feeds/spc_1");
  assert.deepEqual(url?.searchParams.getAll("social_post_id"), ["sp_1", "sp_9"]);
  assert.deepEqual(url?.searchParams.getAll("external_post_id"), ["idem_1"]);
  assert.equal(url?.searchParams.get("platform_post_id"), null);
  assert.equal(url?.searchParams.get("expand"), "metrics");
  assert.equal(url?.searchParams.get("limit"), "50");
  assert.deepEqual(result, {
    items: [
      {
        social_post_id: "sp_1",
        external_post_id: "idem_1",
        social_post_result_id: "spr_1",
        platform_post_id: "native_1",
        social_account_id: "spc_1",
        platform_url: "https://www.instagram.com/p/abc/",
        caption: "Hello",
        metrics: { likes: 3 },
      },
    ],
    nextCursor: "c2",
  });

  await assert.rejects(adapter.native.findFeedPosts({ account: account("instagram") }, context), {
    code: "invalid_input",
  });
  assert.equal(calls.length, 1);
});
