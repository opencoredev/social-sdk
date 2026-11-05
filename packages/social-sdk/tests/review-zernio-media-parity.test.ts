import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { zernio } from "../src/cloud/zernio.js";
import { zernioNative } from "../src/cloud/zernio-native.js";
import type { AdapterOperationContext } from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "review-zernio-media-parity",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
};

it("submits a draft with a media ref uploaded by the normalized Zernio adapter", async () => {
  const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "account1" });
  let creates = 0;

  const options: Parameters<typeof zernio>[0] = {
    apiKey: "fixture-key",
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/api/v1/posts");
      assert.equal(init?.method, "POST");
      assert.equal(
        String(init?.body),
        JSON.stringify({
          content: "Draft with uploaded media",
          mediaItems: [
            { type: "image", url: "https://cdn.example.test/image.jpg", mimeType: "image/jpeg" },
          ],
          platforms: [{ platform: "twitter", accountId: "account1" }],
          isDraft: true,
        }),
      );
      creates++;

      return Response.json({
        post: {
          _id: "draft1",
          status: "draft",
          platforms: [{ platform: "twitter", accountId: "account1", status: "pending" }],
        },
      });
    },
  };

  const adapter = zernio(options);
  const native = zernioNative(options);

  const ref = await adapter.media.upload(
    {
      kind: "image",
      mimeType: "image/jpeg",
      source: { kind: "https-url", url: "https://cdn.example.test/image.jpg" },
    },
    account,
    context,
  );

  await assert.doesNotReject(async () => {
    const outcome = await native.submitPost(
      {
        account,
        content: {
          text: "Draft with uploaded media",
          media: [{ kind: "image", mimeType: "image/jpeg", source: { kind: "media-ref", ref } }],
        },
        submission: { kind: "draft" },
      },
      context,
    );

    assert.equal(outcome.state, "accepted");
  });

  assert.equal(creates, 1);
});
