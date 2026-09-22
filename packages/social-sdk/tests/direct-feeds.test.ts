import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SocialError,
  connectedAccountRef,
  type AdapterOperationContext,
} from "../src/core/index.js";
import { x } from "../src/platforms/x.js";
import { threads } from "../src/platforms/threads.js";
import { instagram } from "../src/platforms/instagram.js";

const xContext: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "feeds",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

const threadsContext: AdapterOperationContext = { ...xContext };

const instagramContext: AdapterOperationContext = {
  ...xContext,
  backendInstance: "instagram",
};

test("X account feeds use pagination_token and return selected fields", async () => {
  const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });
  let requested: URL | undefined;

  const adapter = x({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async (input, init) => {
      assert.equal(init?.method, "GET");
      requested = new URL(String(input));

      return Response.json({
        data: [
          {
            id: "post-1",
            text: "hello",
            author_id: "u1",
            created_at: "2026-01-01",
            secret: "omit",
          },
        ],
        meta: { next_token: "next-x" },
      });
    },
  });

  const page = await adapter.posts!.list!(account, { cursor: "cursor-x", limit: 10 }, xContext);
  assert.equal(requested?.pathname, "/2/users/u1/tweets");
  assert.equal(requested?.searchParams.get("pagination_token"), "cursor-x");
  assert.equal(requested?.searchParams.get("max_results"), "10");
  assert.equal(page.nextCursor, "next-x");
  assert.deepEqual(page.items[0], {
    id: "post-1",
    text: "hello",
    author_id: "u1",
    created_at: "2026-01-01",
  });
  await assert.rejects(
    adapter.posts!.list!(account, { limit: 101 }, xContext),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
    (error: unknown) => error instanceof SocialError && error.code === "invalid_input",
  );
});

test("Threads account feeds use the after cursor and enforce account authorization", async () => {
  const account = connectedAccountRef({ backend: "default", platform: "threads", accountId: "u1" });
  let requested: URL | undefined;

  const adapter = threads({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async (input, init) => {
      assert.equal(init?.method, "GET");
      requested = new URL(String(input));

      return Response.json({
        data: [
          {
            id: "thread-1",
            text: "hello",
            username: "u1",
            permalink: "https://threads.invalid/1",
            secret: "omit",
          },
        ],
        paging: { cursors: { after: "next-threads" }, next: "https://graph.threads.net/next" },
      });
    },
  });

  const page = await adapter.posts!.list!(
    account,
    { cursor: "cursor-threads", limit: 4 },
    threadsContext,
  );

  assert.equal(requested?.pathname, "/v1.0/u1/threads");
  assert.equal(requested?.searchParams.get("after"), "cursor-threads");
  assert.equal(requested?.searchParams.get("limit"), "4");
  assert.equal(page.nextCursor, "next-threads");
  assert.equal(page.items[0]?.id, "thread-1");
  assert.equal("secret" in (page.items[0] ?? {}), false);
  await assert.rejects(
    adapter.posts!.list!({ ...account, accountId: "other" }, {}, threadsContext),
  );

  const finalAdapter = threads({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async () => Response.json({ data: [], paging: { cursors: { after: "stale" } } }),
  });

  assert.equal(
    (await finalAdapter.posts!.list!(account, { limit: 1 }, threadsContext)).nextCursor,
    undefined,
  );
  await assert.rejects(
    adapter.posts!.list!(account, { limit: 101 }, threadsContext),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
    (error: unknown) => error instanceof SocialError && error.code === "invalid_input",
  );
});

test("Instagram account feeds use the after cursor and selected media fields", async () => {
  const account = connectedAccountRef({
    backend: "instagram",
    platform: "instagram",
    accountId: "ig1",
  });

  let requested: URL | undefined;

  const adapter = instagram({
    auth: { accountId: "ig1", accessToken: "token" },
    fetch: async (input, init) => {
      assert.equal(init?.method, "GET");
      requested = new URL(String(input));

      return Response.json({
        data: [
          {
            id: "media-1",
            caption: "hello",
            media_type: "IMAGE",
            permalink: "https://instagram.invalid/1",
            secret: "omit",
          },
        ],
        paging: { cursors: { after: "next-instagram" }, next: "https://graph.instagram.com/next" },
      });
    },
  });

  const page = await adapter.posts!.list!(
    account,
    { cursor: "cursor-instagram", limit: 6 },
    instagramContext,
  );

  assert.equal(requested?.pathname, "/v25.0/ig1/media");
  assert.equal(requested?.searchParams.get("after"), "cursor-instagram");
  assert.equal(requested?.searchParams.get("limit"), "6");
  assert.equal(page.nextCursor, "next-instagram");
  assert.deepEqual(page.items[0], {
    id: "media-1",
    caption: "hello",
    media_type: "IMAGE",
    permalink: "https://instagram.invalid/1",
  });

  const finalAdapter = instagram({
    auth: { accountId: "ig1", accessToken: "token" },
    fetch: async () => Response.json({ data: [], paging: { cursors: { after: "stale" } } }),
  });

  assert.equal(
    (await finalAdapter.posts!.list!(account, { limit: 1 }, instagramContext)).nextCursor,
    undefined,
  );
  await assert.rejects(
    adapter.posts!.list!(account, { limit: 101 }, instagramContext),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
    (error: unknown) => error instanceof SocialError && error.code === "invalid_input",
  );
});
