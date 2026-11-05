import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";
import { instagram } from "../src/platforms/instagram.js";

const account = connectedAccountRef({
  backend: "instagram",
  platform: "instagram",
  accountId: "1784",
});

const context: AdapterOperationContext = {
  backendInstance: "instagram",
  correlationId: "instagram-publish-warnings",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

async function publishWithWarnings() {
  const calls: string[] = [];

  const adapter = instagram({
    auth: { accountId: "1784", accessToken: "test-fixture", flavor: "facebook-login" },
    fetch: async (input) => {
      const url = new URL(String(input));

      calls.push(url.pathname);

      if (url.pathname.endsWith("/media")) return Response.json({ id: "container1" });

      if (url.searchParams.get("fields") === "id,status_code,status")
        return Response.json({ id: "container1", status_code: "FINISHED" });

      if (url.pathname.endsWith("/media_publish"))
        return Response.json({
          id: "post1",
          config_issue: "CAPTION_NOT_ATTACHED",
          caption_add_on_attachment_status: "POLL_CREATION_FAILURE",
        });

      throw new Error("Unexpected fake Graph request");
    },
  });

  assert.ok(adapter.posts);

  const initial = await adapter.posts.publishTarget(
    {
      targetIndex: 0,
      targetKey: "instagram",
      account,
      content: {
        text: "Which roast?",
        media: [
          {
            kind: "image",
            mimeType: "image/jpeg",
            source: { kind: "https-url", url: "https://cdn.example.test/coffee.jpg" },
          },
        ],
      },
      options: { poll: { options: ["Light", "Dark"] } },
    },
    context,
  );

  assert.equal(initial.state, "published");

  assert.ok(initial.state === "published");

  assert.deepEqual(
    initial.issues?.map((issue) => issue.code),
    ["CAPTION_NOT_ATTACHED", "POLL_CREATION_FAILURE"],
  );

  assert.ok(initial.delivery);

  return { adapter, initial, delivery: initial.delivery, calls };
}

test("Instagram getDelivery preserves known caption and poll failures after publication", async () => {
  const { adapter, initial, delivery, calls } = await publishWithWarnings();

  assert.ok(adapter.posts?.getDelivery);

  const reconciled = await adapter.posts.getDelivery(delivery, context);

  assert.equal(reconciled.state, "published");

  assert.ok(reconciled.state === "published");

  assert.equal(calls.filter((path) => path.endsWith("/media_publish")).length, 1);

  assert.deepEqual(reconciled.issues, initial.issues);
});

test("Instagram resumePublication preserves known caption and poll failures", async () => {
  const { adapter, initial, delivery, calls } = await publishWithWarnings();

  assert.ok(adapter.native);

  const resumed = await adapter.native.resumePublication(account, delivery.deliveryId, context);

  assert.equal(resumed.state, "published");

  assert.ok(resumed.state === "published");

  assert.equal(calls.filter((path) => path.endsWith("/media_publish")).length, 1);

  assert.deepEqual(resumed.issues, initial.issues);
});
