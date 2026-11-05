import { it } from "node:test";
import assert from "node:assert/strict";
import { postiz } from "../src/cloud/postiz.js";
import { SocialError } from "../src/core/errors.js";
import type {
  AdapterOperationContext,
  DeliveryRef,
  JsonObject,
  JsonValue,
} from "../src/core/types.js";
import { isJsonValue } from "../src/transport/json.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-11-04T12:00:00.000Z");

const future = "2026-11-06T09:00:00.000Z";

const delivery: DeliveryRef = {
  kind: "delivery",
  version: 1,
  backend: "default",
  platform: "x",
  accountId: "int1",
  deliveryId: `p1@${future}`,
};

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly body: JsonValue | undefined;
}

/** A fake Postiz whose post list holds `post` and whose create answers with `created`. */
function fakePostiz(
  post: JsonObject,
  created: JsonValue = [{ postId: "p1", integration: "int1" }],
) {
  const calls: Call[] = [];

  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const parsed: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;

      calls.push({ method, url, body: isJsonValue(parsed) ? parsed : undefined });

      if (url.pathname === "/public/v1/upload-from-url")
        return Response.json({ id: "m1", path: "https://uploads.postiz.com/new.png" });

      if (method === "POST") return Response.json(created);

      return Response.json({ posts: [post] });
    },
  });

  return { adapter, calls };
}

const row = (fields: JsonObject): JsonObject => ({
  id: "p1",
  content: "Old text",
  publishDate: future,
  releaseURL: null,
  releaseId: null,
  state: "QUEUE",
  group: "5e1f0c3a-8b2d-4f6e-9a7c-1d3b5f7e9a20",
  settings: { __type: "x", who_can_reply_post: "following" },
  tags: [{ tag: { id: "t1", name: "Launch", color: "#fff" } }],
  integration: { id: "int1", providerIdentifier: "x", name: "Demo" },
  ...fields,
});

it("Postiz edits a queued post in place with type update [feature:postiz.edit.update_post]", async () => {
  const { adapter, calls } = fakePostiz(row({ intervalInDays: 7 }));

  const outcome = await adapter.native.editPost(
    delivery,
    {
      text: "New text",
      media: [
        {
          kind: "image",
          source: { kind: "https-url", url: "https://cdn.example.test/new.png" },
          mimeType: "image/png",
          altText: "A new chart",
        },
      ],
    },
    context,
  );

  const create = calls.find(
    (call) => call.method === "POST" && call.url.pathname.endsWith("/posts"),
  );

  assert.deepEqual(create?.body, {
    type: "update",
    date: future,
    shortLink: false,
    inter: 7,
    tags: [{ value: "Launch", label: "Launch" }],
    posts: [
      {
        integration: { id: "int1" },
        value: [
          {
            id: "p1",
            content: "New text",
            image: [{ id: "m1", path: "https://uploads.postiz.com/new.png", alt: "A new chart" }],
          },
        ],
        settings: { __type: "x", who_can_reply_post: "following" },
      },
    ],
  });
  assert.equal(outcome.state, "scheduled");
});

it("Postiz needs republish to edit a published post, then publishes it again now", async () => {
  const published = row({
    state: "PUBLISHED",
    releaseId: "1900",
    releaseURL: "https://x.com/i/status/1900",
    settings: JSON.stringify({ who_can_reply_post: "everyone" }),
  });

  const refused = fakePostiz(published);

  await assert.rejects(
    refused.adapter.native.editPost(delivery, { text: "Fixed typo", media: [] }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
  assert.equal(refused.calls.filter((call) => call.method === "POST").length, 0);

  const { adapter, calls } = fakePostiz(published);

  await adapter.native.editPost(
    delivery,
    { text: "Fixed typo", media: [], republish: true },
    context,
  );

  const create = calls.find((call) => call.method === "POST");

  assert.deepEqual(create?.body, {
    type: "now",
    date: clock().toISOString(),
    shortLink: false,
    republish: true,
    tags: [{ value: "Launch", label: "Launch" }],
    posts: [
      {
        integration: { id: "int1" },
        value: [{ id: "p1", content: "Fixed typo", image: [] }],
        settings: { who_can_reply_post: "everyone" },
      },
    ],
  });

  const queued = fakePostiz(row({}));

  await assert.rejects(
    queued.adapter.native.editPost(delivery, { text: "x", media: [], republish: true }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Postiz reports an unconfirmed edit as ambiguous", async () => {
  const { adapter } = fakePostiz(row({}), [{ postId: "other", integration: "int1" }]);

  await assert.rejects(
    adapter.native.editPost(delivery, { text: "New", media: [] }, context),
    (error) => error instanceof SocialError && error.code === "ambiguous_outcome",
  );
});

it("Postiz lists one customer's posts with the customer filter [feature:postiz.read.list_posts_customer]", async () => {
  const { adapter, calls } = fakePostiz(
    row({
      state: "ERROR",
      error: "Account banned from posting",
      intervalInDays: 7,
      integration: { id: "int1", providerIdentifier: "slack", name: "Team" },
    }),
  );

  const posts = await adapter.native.listPosts(
    {
      startDate: "2026-11-01T00:00:00.000Z",
      endDate: "2026-11-30T00:00:00.000Z",
      customer: "cust_1",
    },
    context,
  );

  assert.deepEqual(Object.fromEntries(calls[0]?.url.searchParams ?? []), {
    startDate: "2026-11-01T00:00:00.000Z",
    endDate: "2026-11-30T00:00:00.000Z",
    customer: "cust_1",
  });
  assert.deepEqual(posts, [
    {
      recordId: `p1@${future}`,
      id: "p1",
      publishDate: future,
      state: "ERROR",
      tags: ["Launch"],
      channel: { id: "int1", identifier: "slack", name: "Team" },
      content: "Old text",
      error: "Account banned from posting",
      repeatEveryDays: 7,
      group: "5e1f0c3a-8b2d-4f6e-9a7c-1d3b5f7e9a20",
    },
  ]);

  await assert.rejects(
    adapter.native.listPosts(
      {
        startDate: "2026-11-01T00:00:00.000Z",
        endDate: "2026-11-30T00:00:00.000Z",
        customer: "a b",
      },
      context,
    ),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("Postiz keeps the platform's failure prose out of a failed delivery", async () => {
  const { adapter } = fakePostiz(row({ state: "ERROR", error: "Account banned from posting" }));
  const outcome = await adapter.posts.getDelivery(delivery, context);

  assert.equal(outcome.state, "failed");
  assert.equal(
    outcome.state === "failed" ? outcome.message : undefined,
    "Postiz reports that this post failed. Inspect the post and channel in Postiz.",
  );
  assert.doesNotMatch(JSON.stringify(outcome), /Account banned/);
});
