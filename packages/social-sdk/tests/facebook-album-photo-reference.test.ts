import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";
import { facebook } from "../src/platforms/facebook.js";

test("Facebook reads the photo reference and delivery returned by an album upload", async () => {
  const account = connectedAccountRef({
    backend: "default",
    platform: "facebook",
    accountId: "123",
  });

  const context: AdapterOperationContext = {
    backendInstance: "default",
    correlationId: "album-photo",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
  };

  const photo = {
    id: "5678",
    name: "Launch night",
    created_time: "2026-11-01T00:00:00+0000",
    updated_time: "2026-11-01T00:00:00+0000",
    link: "https://www.facebook.com/photo.php?fbid=5678",
  };

  const photoFields = new Set(Object.keys(photo));
  const calls: string[] = [];

  const adapter = facebook({
    auth: { pageId: "123", accessToken: "test-fixture" },
    fetch: async (input, init) => {
      const url = new URL(String(input));

      calls.push(url.pathname);

      if (url.pathname === "/v27.0/4041/photos" && init?.method === "POST")
        return Response.json({ id: photo.id });

      if (url.pathname === `/v27.0/${photo.id}` && init?.method === "GET") {
        const requested = (url.searchParams.get("fields") ?? "id").split(",");
        const unsupported = requested.find((field) => !photoFields.has(field));

        if (unsupported !== undefined)
          return Response.json(
            {
              error: {
                type: "OAuthException",
                code: 100,
                message: `Tried accessing nonexisting field (${unsupported}) on node type (Photo)`,
              },
            },
            { status: 400 },
          );

        return Response.json(photo);
      }

      throw new Error("Unexpected fake Graph request");
    },
  });

  assert.ok(adapter.posts?.get);

  const published = await adapter.posts.publishTarget(
    {
      targetIndex: 0,
      targetKey: "facebook",
      account,
      options: { albumId: "4041" },
      content: {
        text: "Launch night",
        media: [
          {
            kind: "image",
            mimeType: "image/jpeg",
            source: { kind: "https-url", url: "https://cdn.example.test/launch.jpg" },
          },
        ],
      },
    },
    context,
  );

  assert.equal(published.state, "published");

  assert.ok(published.state === "published");

  assert.equal(published.post.postId, photo.id);

  const get = adapter.posts.get;

  await assert.doesNotReject(async () => {
    const read = await get(published.post, context);

    assert.equal(read["id"], photo.id);
  });

  assert.ok(published.delivery);

  assert.ok(adapter.posts.getDelivery);

  const reconciled = await adapter.posts.getDelivery(published.delivery, context);

  assert.equal(reconciled.state, "published");

  assert.ok(reconciled.state === "published");

  assert.deepEqual(reconciled.post, published.post);

  assert.deepEqual(calls, ["/v27.0/4041/photos", "/v27.0/5678", "/v27.0/5678"]);
});
