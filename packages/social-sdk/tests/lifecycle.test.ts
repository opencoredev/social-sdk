/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSocial, type BackendPostRef, type ScheduledJobRef } from "../src/index.js";
import { zernio } from "../src/cloud/zernio.js";
import { postForMe } from "../src/cloud/post-for-me.js";

const job: ScheduledJobRef = {
  kind: "scheduled-job",
  version: 1,
  backend: "default",
  platform: "threads",
  accountId: "account",
  jobId: "record",
};

const record: BackendPostRef = {
  kind: "backend-post",
  version: 1,
  backend: "default",
  platform: "threads",
  accountId: "account",
  recordId: "record",
};

const now = () => new Date("2026-01-01T00:00:00Z");

const at = "2027-01-01T00:00:00Z";

const destination = { platform: "threads", accountId: "account", status: "pending" };

test("Zernio schedule cancellation checks ownership and uses DELETE once", async () => {
  const calls: string[] = [];

  const social = createSocial({
    backend: zernio({
      apiKey: "fixture",
      clock: now,
      fetch: async (_url, init) => {
        calls.push(init?.method ?? "GET");

        return Response.json(
          init?.method === "DELETE"
            ? { message: "Post deleted successfully" }
            : {
                post: {
                  _id: "record",
                  status: "scheduled",
                  scheduledFor: at,
                  platforms: [destination],
                },
              },
        );
      },
    }),
  });

  assert.deepEqual(await social.posts.cancelScheduled(job), {
    state: "cancelled",
    backendRecord: "deleted",
  });
  assert.deepEqual(calls, ["GET", "DELETE"]);
});

test("lifecycle denies unauthorized references, wrong kinds, shared records and dispatched schedules", async () => {
  let calls = 0;

  const backend = zernio({
    apiKey: "fixture",
    clock: now,
    fetch: async () => {
      calls++;

      return Response.json({});
    },
  });

  const denied = createSocial({
    backend,
    authorization: {
      authorizeTargets: async ({ accounts }) =>
        accounts.map((account) => ({ account, allowed: false })),
    },
  });

  await assert.rejects(denied.posts.cancelScheduled(job), { code: "unauthorized" });
  await assert.rejects(
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated external boundary or fixture contract.
    createSocial({ backend }).posts.cancelScheduled({
      ...job,
      kind: "platform-post",
    } as unknown as ScheduledJobRef),
    { code: "invalid_input" },
  );
  assert.equal(calls, 0);

  for (const patch of [
    { platforms: [destination, destination] },
    { platforms: [{ ...destination, accountId: "someone-else" }] },
    { status: "processing" },
    { scheduledFor: "2020-01-01T00:00:00Z" },
  ]) {
    const methods: string[] = [];

    const social = createSocial({
      backend: zernio({
        apiKey: "fixture",
        clock: now,
        fetch: async (_url, init) => {
          methods.push(init?.method ?? "GET");

          return Response.json({
            post: {
              _id: "record",
              status: "scheduled",
              scheduledFor: at,
              platforms: [destination],
              ...patch,
            },
          });
        },
      }),
    });

    await assert.rejects(social.posts.cancelScheduled(job));
    assert.deepEqual(methods, ["GET"]);
  }
});

test("Post for Me cancellation preserves schedule and content while reverting to draft", async () => {
  const calls: string[] = [];
  const media = [{ url: "https://cdn.example/photo.jpg" }];

  const social = createSocial({
    backend: postForMe({
      apiKey: "fixture",
      clock: now,
      fetch: async (_url, init) => {
        calls.push(init?.method ?? "GET");

        if (init?.method === "PUT") {
          assert.deepEqual(JSON.parse(String(init.body)), {
            caption: "caption",
            social_accounts: ["account"],
            scheduled_at: at,
            isDraft: true,
            media,
          });

          return Response.json({ id: "record", status: "draft" });
        }

        return Response.json({
          id: "record",
          status: "scheduled",
          scheduled_at: at,
          caption: "caption",
          media,
          social_accounts: [{ id: "account", platform: "threads" }],
        });
      },
    }),
  });

  assert.deepEqual(await social.posts.cancelScheduled(job), {
    state: "cancelled",
    backendRecord: "retained",
  });
  assert.deepEqual(calls, ["GET", "PUT"]);
});

test("backend record deletion accepts drafts only and checks provider confirmation", async () => {
  for (const status of ["draft", "scheduled", "processed"]) {
    const methods: string[] = [];

    const social = createSocial({
      backend: postForMe({
        apiKey: "fixture",
        fetch: async (_url, init) => {
          methods.push(init?.method ?? "GET");

          return Response.json(
            init?.method === "DELETE"
              ? { success: true }
              : { id: "record", status, social_accounts: [{ id: "account", platform: "threads" }] },
          );
        },
      }),
    });

    if (status === "draft") {
      await social.posts.deleteBackendRecord(record);
      assert.deepEqual(methods, ["GET", "DELETE"]);
    } else {
      await assert.rejects(social.posts.deleteBackendRecord(record));
      assert.deepEqual(methods, ["GET"]);
    }
  }
});

test("Zernio native removal validates native ID and POSTs unpublish without deleting record", async () => {
  const calls: string[] = [];

  const social = createSocial({
    backend: zernio({
      apiKey: "fixture",
      fetch: async (url, init) => {
        calls.push(`${init?.method} ${new URL(String(url)).pathname}`);

        if (init?.method === "POST") {
          assert.deepEqual(JSON.parse(String(init.body)), { platform: "threads" });

          return Response.json({ success: true });
        }

        return Response.json({
          post: {
            _id: "record",
            platforms: [{ ...destination, status: "published", platformPostId: "native" }],
          },
        });
      },
    }),
  });

  const post = {
    kind: "platform-post" as const,
    version: 1 as const,
    backend: "default",
    platform: "threads",
    accountId: "account",
    postId: "native",
    native: { backendRecordId: "record" },
  };

  await assert.rejects(social.posts.removeFromPlatform({ ...post, postId: "someone-elses-post" }));
  await social.posts.removeFromPlatform(post);
  assert.deepEqual(calls, [
    "GET /api/v1/posts/record",
    "GET /api/v1/posts/record",
    "POST /api/v1/posts/record/unpublish",
  ]);
});

test("lost DELETE response is ambiguous and never retried", async () => {
  let writes = 0;

  const social = createSocial({
    backend: zernio({
      apiKey: "fixture",
      clock: now,
      fetch: async (_url, init) => {
        if (init?.method === "DELETE") {
          writes++;
          throw new Error("connection lost");
        }

        return Response.json({
          post: { _id: "record", status: "scheduled", scheduledFor: at, platforms: [destination] },
        });
      },
    }),
  });

  await assert.rejects(
    social.posts.cancelScheduled(job, { retryBudget: { maxAttempts: 5, maxElapsedMs: 1000 } }),
    { code: "ambiguous_outcome" },
  );
  assert.equal(writes, 1);
});
