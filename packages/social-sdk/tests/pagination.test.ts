import { test } from "node:test";
import assert from "node:assert/strict";
import { createSocial, iterateItems } from "../src/index.js";
import { mockBackend } from "../src/testing/index.js";

test("account cursors bind backend, tenant and page size before any dispatch", async () => {
  const base = mockBackend();
  let calls = 0;

  const adapter = {
    ...base,
    accounts: {
      ...base.accounts!,
      async list(input: { cursor?: string }) {
        calls++;
        assert.ok(input.cursor === undefined || input.cursor === "upstream-token");

        return { items: [], nextCursor: "upstream-token" };
      },
    },
  };

  const social = createSocial({ backends: { a: adapter, b: adapter } });

  const first = await social.accounts.list({
    backend: "a",
    limit: 5,
    authorization: { tenantId: "tenant" },
  });

  assert.ok(first.nextCursor?.startsWith("social-v1."));

  for (const options of [
    { backend: "b", limit: 5, authorization: { tenantId: "tenant" } },
    { backend: "a", limit: 6, authorization: { tenantId: "tenant" } },
    { backend: "a", limit: 5, authorization: { tenantId: "other" } },
  ])
    await assert.rejects(social.accounts.list({ ...options, cursor: first.nextCursor! }));
  assert.equal(calls, 1);
  await social.accounts.list({
    backend: "a",
    limit: 5,
    authorization: { tenantId: "tenant" },
    cursor: first.nextCursor!,
  });
  assert.equal(calls, 2);
});

test("iterators are lazy, bounded and stop after early return", async () => {
  let calls = 0;

  const values = iterateItems(async () => {
    calls++;

    return { items: [1, 2], nextCursor: String(calls) };
  });

  assert.equal(calls, 0);

  for await (const value of values) {
    assert.equal(value, 1);
    break;
  }

  assert.equal(calls, 1);
  const bounded: number[] = [];

  for await (const value of iterateItems(async () => ({ items: [1, 2], nextCursor: "next" }), {
    maxItems: 1,
  }))
    bounded.push(value);
  assert.deepEqual(bounded, [1]);
});

test("iterators reject repeated cursors and respect cancellation between requests", async () => {
  await assert.rejects(async () => {
    for await (const _item of iterateItems(async () => ({ items: [], nextCursor: "repeat" }))) {
      /* No items. */
    }
  });
  let calls = 0;
  const controller = new AbortController();
  await assert.rejects(async () => {
    for await (const _item of iterateItems(
      async () => {
        calls++;

        return { items: [1], nextCursor: "next" };
      },
      { signal: controller.signal },
    ))
      controller.abort();
  });
  assert.equal(calls, 1);
});

test("post feeds bind cursors to account and traverse lazily through the public facade", async () => {
  const base = mockBackend();
  let calls = 0;

  const adapter = {
    ...base,
    capabilities: {
      ...base.capabilities,
      capabilities: [
        ...base.capabilities.capabilities,
        { platform: "*", operation: "posts.list", availability: "available" as const },
      ],
    },
    posts: {
      ...base.posts!,
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
      async list(_account: unknown, input: { cursor?: string }) {
        calls++;

        return {
          items: [{ postId: input.cursor ? "second" : "first" }],
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(input.cursor ? {} : { nextCursor: "upstream" }),
        };
      },
    },
  };

  const social = createSocial({ backend: adapter });

  const account = {
    kind: "connected-account" as const,
    version: 1 as const,
    backend: "default",
    platform: "bluesky",
    accountId: "a",
  };

  const page = await social.posts.list(account, { limit: 1 });
  assert.equal(calls, 1);
  await assert.rejects(
    social.posts.list({ ...account, accountId: "b" }, { cursor: page.nextCursor!, limit: 1 }),
  );
  assert.equal(calls, 1);
  const ids = [];

  for await (const item of social.posts.iterate(account, { maxPages: 2 })) ids.push(item["postId"]);
  assert.deepEqual(ids, ["first", "second"]);
  assert.equal(calls, 3);
});
