import { test } from "node:test";
import assert from "node:assert/strict";
import { createExampleHandler } from "../src/app.js";
import { mockBackend } from "@opencoredev/social-sdk/testing";
import { openExampleDatabase } from "../src/storage.js";
import { SocialError } from "@opencoredev/social-sdk";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
function request(path: string, value?: unknown, headers: Record<string, string> = {}) {
  return new Request(
    `http://localhost:3030${path}`,
    value === undefined
      ? { headers: { host: "localhost:3030", ...headers } }
      : {
          method: "POST",
          headers: { host: "localhost:3030", "content-type": "application/json", ...headers },
          body: JSON.stringify(value),
        },
  );
}

const publication = {
  accountIds: ["mock-account-1"],
  format: "text",
  text: "hello",
  idempotencyKey: "intent-one",
};

test("selects server-authorized accounts, prepares and publishes under the actual backend name", async () => {
  const backend = mockBackend({ backendInstance: "demo" });
  const { handle } = createExampleHandler({ backend, backendName: "demo" });
  const accounts = await (await handle(request("/api/accounts"))).json();
  assert.equal(accounts.accounts[0].ref.backend, "demo");
  assert.equal(
    (await handle(request("/api/connect/callback", { accountId: "mock-account-1" }))).status,
    200,
  );
  assert.equal(
    (await handle(request("/api/connect/callback", { accountId: "other-tenant-account" }))).status,
    403,
  );
  assert.equal(
    (await (await handle(request("/api/prepare", publication))).json()).preparation.ok,
    true,
  );
  const response = await handle(request("/api/publish", publication));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.outcomes[0].state, "published");
  await handle(request("/api/publish", publication));
  assert.equal(
    backend.testing.history().filter((entry) => entry.operation === "posts.publishTarget").length,
    1,
  );
  assert.equal(
    (await handle(request("/api/publish", { ...publication, text: "different intent" }))).status,
    409,
  );
});

test("rejects arbitrary accounts, missing intentional keys, malformed and oversized bodies before dispatch", async () => {
  const backend = mockBackend();
  const { handle } = createExampleHandler({ backend });
  assert.equal(
    (await handle(request("/api/publish", { ...publication, accountIds: ["unauthorized"] })))
      .status,
    403,
  );
  assert.equal(
    (await handle(request("/api/publish", { ...publication, idempotencyKey: undefined }))).status,
    400,
  );
  assert.equal(
    (await handle(request("/api/publish", { ...publication, accountIds: ["mock-account-1", 1] })))
      .status,
    400,
  );
  assert.equal(
    (await handle(new Request("http://localhost:3030/api/publish", { method: "POST", body: "{" })))
      .status,
    400,
  );
  assert.equal(
    (
      await handle(
        new Request("http://localhost:3030/api/publish", {
          method: "POST",
          headers: { host: "localhost:3030" },
          body: "x".repeat(1_000_001),
        }),
      )
    ).status,
    413,
  );
  assert.equal(
    backend.testing.history().filter((entry) => entry.operation === "posts.publishTarget").length,
    0,
  );
});

test("keeps video processing durable and reconciles after handler reconstruction", async () => {
  const db = await openExampleDatabase();
  const backend = mockBackend({ scenario: "media-processing-then-success" });
  const first = createExampleHandler({ backend, database: db });

  const input = {
    ...publication,
    format: "video",
    mediaUrl: "https://media.example.test/video.mp4",
    mediaMime: "video/mp4",
  };

  const sent = await (await first.handle(request("/api/publish", input))).json();
  assert.equal(sent.result.outcomes[0].state, "processing");
  backend.testing.advanceProcessing();
  const restarted = createExampleHandler({ backend, database: db });

  const response = await restarted.handle(
    request("/api/reconcile", { idempotencyKey: input.idempotencyKey }),
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.outcomes[0].state, "published");
  assert.equal(
    (await (await restarted.handle(request("/api/publish", input))).json()).result.outcomes[0]
      .state,
    "published",
  );
  assert.equal(
    backend.testing.history().filter((entry) => entry.operation === "posts.publishTarget").length,
    1,
  );
  await db.close();
});

test("applies a verified pending event after restart, deduplicates and keeps terminal results", async () => {
  const db = await openExampleDatabase();
  const backend = mockBackend({ scenario: "media-processing-then-success" });
  const first = createExampleHandler({ backend, database: db });
  await first.handle(request("/api/publish", publication));

  const event = {
    eventId: "event-1",
    accountId: "mock-account-1",
    publicationKey: publication.idempotencyKey,
    type: "post.updated",
  };

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
  const send = (value: unknown) => request("/api/events", value, { "x-mock-signature": "valid" });
  assert.equal((await first.handle(request("/api/events", event))).status, 401);
  assert.deepEqual(await (await first.handle(send(event))).json(), {
    state: "accepted",
    quarantined: false,
  });
  assert.deepEqual(await (await first.handle(send(event))).json(), {
    state: "duplicate",
    quarantined: false,
  });
  assert.equal(
    (await (await first.handle(send({ ...event, eventId: "unknown", accountId: "other" }))).json())
      .quarantined,
    true,
  );
  backend.testing.advanceProcessing();
  const restarted = createExampleHandler({ backend, database: db });
  assert.deepEqual(await (await restarted.handle(request("/api/events/process", {}))).json(), {
    applied: 1,
    pending: 0,
  });
  assert.deepEqual(await (await restarted.handle(request("/api/events/process", {}))).json(), {
    applied: 0,
    pending: 0,
  });
  backend.testing.reset(); // An old provider processing observation must not undo publication.
  await restarted.handle(send({ ...event, eventId: "older-event" }));
  await restarted.handle(request("/api/events/process", {}));

  const current = await (
    await restarted.handle(
      request("/api/reconcile", { idempotencyKey: publication.idempotencyKey }),
    )
  ).json();

  assert.equal(current.result.outcomes[0].state, "published");
  await db.close();
});

test("reports each mixed outcome, keeps metrics server-side and replies to a returned comment", async () => {
  const { handle } = createExampleHandler({
    backend: mockBackend({ scenario: "mixed-success-failure" }),
  });

  const result = await (
    await handle(
      request("/api/publish", { ...publication, accountIds: ["mock-account-1", "mock-account-2"] }),
    )
  ).json();

  assert.deepEqual(
    result.result.outcomes.map((outcome: { state: string }) => outcome.state),
    ["published", "failed"],
  );
  const post = { accountId: "mock-account-1", platform: "x", postId: "post-1" };
  const metrics = await handle(request("/api/metrics", post));
  assert.equal(metrics.status, 200);
  assert.equal((await metrics.json()).metrics[0].name, "views");
  const comments = await (await handle(request("/api/comments/list", post))).json();

  const reply = await handle(
    request("/api/comments/reply", { ...post, commentId: comments.items[0].id, text: "reply" }),
  );

  assert.equal(reply.status, 200);
  assert.match((await reply.json()).comment.commentId, /^mock-reply-/);
});

test("blocks cross-origin browser mutations before backend dispatch", async () => {
  const backend = mockBackend();
  const { handle } = createExampleHandler({ backend });

  const response = await handle(
    request("/api/publish", publication, {
      origin: "https://other.example.test",
      "sec-fetch-site": "cross-site",
    }),
  );

  assert.equal(response.status, 403);
  assert.equal(backend.testing.history().length, 0);
});

test("rejects unallowlisted hosts and origins before backend dispatch", async () => {
  const backend = mockBackend();
  const { handle } = createExampleHandler({ backend });

  assert.equal(
    (await handle(new Request("http://attacker.test/api/publish", { method: "POST" }))).status,
    421,
  );
  assert.equal(
    (
      await handle(
        request("/api/publish", publication, {
          origin: "http://attacker.test",
        }),
      )
    ).status,
    403,
  );
  assert.equal(backend.testing.history().length, 0);
});

test("maps SocialError codes to their HTTP status", async () => {
  for (const [code, status] of [
    ["rate_limited", 429],
    ["upstream_failure", 502],
    ["timeout", 504],
    ["not_found", 404],
    ["invalid_input", 400],
  ] as const) {
    const base = mockBackend();

    const backend = {
      ...base,
      accounts: {
        ...base.accounts,
        async list() {
          throw new SocialError({ code, operation: "accounts.list", message: code });
        },
      },
      posts: {
        ...base.posts,
        async publishTarget() {
          throw new SocialError({ code, operation: "posts.publishTarget", message: code });
        },
      },
    };

    const response = await createExampleHandler({ backend }).handle(request("/api/accounts"));

    assert.equal(response.status, status, code);
    assert.equal((await response.json()).error, code);
  }
});
