import assert from "node:assert/strict";
import { it } from "node:test";
import { connectedAccountRef, createSocial, platformPostRef, profileRef } from "../src/index.js";
import type { AdapterOperationContext } from "../src/index.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "1" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "confirmation",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

it("requires confirmed graph outcomes, including pending follows", async () => {
  for (const data of [
    { following: false, pending_follow: true },
    { following: true, pending_follow: true },
    {},
    { following: "true" },
  ]) {
    const social = createSocial({
      backend: x({
        auth: { userId: "1", accessToken: "fixture" },
        fetch: async () => Response.json({ data }),
      }),
    });

    await assert.rejects(
      social.graph.follow(
        profileRef({
          backend: account.backend,
          platform: "x",
          accountId: account.accountId,
          profileId: "2",
        }),
      ),
      {
        code: "ambiguous_outcome",
        retryDisposition: { kind: "reconcile-first" },
      },
    );
  }

  for (const action of ["mute", "block"] as const) {
    const social = createSocial({
      backend: x({
        auth: { userId: "1", accessToken: "fixture" },
        fetch: async () => Response.json({ data: { muting: false, blocking: false } }),
      }),
    });

    await assert.rejects(
      social.graph[action](
        profileRef({
          backend: account.backend,
          platform: "x",
          accountId: account.accountId,
          profileId: "2",
        }),
      ),
      {
        code: "ambiguous_outcome",
        retryDisposition: { kind: "reconcile-first" },
      },
    );
  }
});

it("requires deleted=true through both deletion entry points", async () => {
  for (const response of [
    { data: { deleted: false } },
    {},
    { data: null },
    { data: { deleted: "true" } },
  ]) {
    const adapter = x({
      auth: { userId: "1", accessToken: "fixture" },
      fetch: async () => Response.json(response),
    });

    assert.ok(adapter.native);
    await assert.rejects(adapter.native.deletePost({ account, postId: "3", context }), {
      code: "ambiguous_outcome",
      retryDisposition: { kind: "reconcile-first" },
    });
    const social = createSocial({ backend: adapter });
    await assert.rejects(
      social.posts.removeFromPlatform(
        platformPostRef({
          backend: account.backend,
          platform: "x",
          accountId: account.accountId,
          postId: "3",
        }),
      ),
      {
        code: "ambiguous_outcome",
        retryDisposition: { kind: "reconcile-first" },
      },
    );
  }
});

it("validates every native engagement confirmation and preserves repost IDs", async () => {
  const actions = [
    ["like", "liked", true],
    ["unlike", "liked", false],
    ["bookmark", "bookmarked", true],
    ["removeBookmark", "bookmarked", false],
    ["repost", "retweeted", true],
    ["undoRepost", "retweeted", false],
  ] as const;

  for (const [action, field, expected] of actions) {
    for (const data of [{}, { [field]: !expected }, { [field]: expected }]) {
      const adapter = x({
        auth: { userId: "1", accessToken: "fixture" },
        fetch: async () => Response.json({ data: { ...data, id: "4" } }),
      });

      assert.ok(adapter.native);

      if (data[field] === expected) {
        const result = await adapter.native[action]({ account, postId: "3", context });

        if (action === "repost") assert.deepEqual(result, { data: { retweeted: true, id: "4" } });
      } else {
        await assert.rejects(adapter.native[action]({ account, postId: "3", context }), {
          code: "ambiguous_outcome",
          retryDisposition: { kind: "reconcile-first" },
        });
      }
    }
  }
});
