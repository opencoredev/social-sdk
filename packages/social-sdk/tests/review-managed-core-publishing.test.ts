import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, createSocial } from "../src/index.js";
import { postfast } from "../src/cloud/postfast.js";
import { zernio } from "../src/cloud/zernio.js";
import { postForMe } from "../src/cloud/post-for-me.js";
import type { AdapterOperationContext, JsonObject } from "../src/core/types.js";
import { isJsonValue } from "../src/transport/json.js";
import { object } from "../src/transport/validation.js";

const clock = () => new Date("2026-11-04T12:00:00.000Z");

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "offline-review",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

it("PostFast permits the documented empty-caption X repost", async () => {
  let submitted = false;

  const social = createSocial({
    clock,
    backend: postfast({
      apiKey: "offline-fixture",
      clock,
      fetch: async (_input, init) => {
        if (init?.method === "POST") {
          submitted = true;

          return Response.json({ postIds: ["post1"] });
        }

        return Response.json({ data: [{ id: "post1", socialMediaId: "x1", status: "SCHEDULED" }] });
      },
    }),
  });

  const request = {
    content: { text: "" },
    targets: [
      {
        account: connectedAccountRef({ backend: "default", platform: "x", accountId: "x1" }),
        options: { repostUrl: "https://x.com/username/status/1234567890123456789" },
      },
    ],
    schedule: { at: "2026-11-05T12:00:00.000Z" },
  };

  const prepared = social.posts.prepare(request);
  assert.equal(prepared.ok, true, JSON.stringify(prepared.issues));
  await social.posts.publish(request);
  assert.equal(submitted, true);
});

it("Zernio permits a LinkedIn reshare without commentary", async () => {
  let submitted = false;

  const social = createSocial({
    clock,
    backend: zernio({
      apiKey: "offline-fixture",
      clock,
      fetch: async () => {
        submitted = true;

        return Response.json({
          post: {
            _id: "post1",
            status: "draft",
            platforms: [
              {
                platform: "linkedin",
                accountId: "li1",
                status: "pending",
              },
            ],
          },
        });
      },
    }),
  });

  const request = {
    content: { text: "" },
    targets: [
      {
        account: connectedAccountRef({
          backend: "default",
          platform: "linkedin",
          accountId: "li1",
        }),
        options: { reshare: "urn:li:share:1234567890123456789" },
      },
    ],
  };

  const prepared = social.posts.prepare(request);
  assert.equal(prepared.ok, true, JSON.stringify(prepared.issues));
  await social.posts.publish(request);
  assert.equal(submitted, true);
});

it("Post for Me preview submits SocialPostMediaDto objects", async () => {
  let body: JsonObject | undefined;

  const adapter = postForMe({
    apiKey: "offline-fixture",
    clock,
    fetch: async (_input, init) => {
      const parsed: unknown = JSON.parse(String(init?.body));
      assert.ok(isJsonValue(parsed));
      body = object(parsed);

      return Response.json([]);
    },
  });

  const url = "https://cdn.example.test/photo.jpg";
  await adapter.native.previewPost(
    {
      account: connectedAccountRef({ backend: "default", platform: "instagram", accountId: "ig1" }),
      content: {
        text: "Preview",
        media: [
          {
            kind: "image",
            mimeType: "image/jpeg",
            altText: "A sunset",
            source: { kind: "https-url", url },
          },
        ],
      },
    },
    context,
  );
  assert.deepEqual(body?.["media"], [{ url, alt_text: "A sunset" }]);
});

it("Post for Me preview preserves media from documented response objects", async () => {
  const url = "https://cdn.example.test/photo.jpg";

  const adapter = postForMe({
    apiKey: "offline-fixture",
    clock,
    fetch: async () =>
      Response.json([
        {
          caption: "Preview",
          platform: "instagram",
          social_account_id: "ig1",
          media: [{ url }],
        },
      ]),
  });

  const result = await adapter.native.previewPost(
    {
      account: connectedAccountRef({ backend: "default", platform: "instagram", accountId: "ig1" }),
      content: { text: "Preview" },
    },
    context,
  );

  assert.deepEqual(result.previews[0]?.media, [url]);
});
