import assert from "node:assert/strict";
import test from "node:test";
import { connectedAccountRef, createSocial } from "@opencoredev/social-sdk";
import { MemoryIdempotencyStore, mockBackend } from "@opencoredev/social-sdk/testing";

test("renders independent mock outcomes", async () => {
  const social = createSocial({
    backend: mockBackend({ scenario: "mixed-success-failure" }),
    idempotencyStore: new MemoryIdempotencyStore(),
  });

  const result = await social.posts.publish({
    content: { text: "test" },
    targets: [
      {
        account: connectedAccountRef({
          backend: "default",
          platform: "x",
          accountId: "mock-account-1",
        }),
      },
      {
        account: connectedAccountRef({
          backend: "default",
          platform: "threads",
          accountId: "mock-account-2",
        }),
      },
    ],
  });

  assert.equal(result.outcomes[0]?.state, "published");
  assert.equal(result.outcomes[1]?.state, "failed");
});

test("runs the authorized server recipe and renders real public outcome fields", async () => {
  const { result } = await import("./mock-server.js");
  const { renderPublishResult } = await import("./render-outcomes.js");
  assert.equal(result.outcomes[0]?.state, "published");
  const rendered = renderPublishResult(result);
  assert.match(rendered[0]!, /published/);
  assert.ok(!rendered[0]!.includes("undefined"));
});

test("connection handlers bind the session and reject replay with an injected provider", async () => {
  const { connectionHandlers } = await import("./connection-callback.js");
  const { MemoryConnectionStore } = await import("@opencoredev/social-sdk/server");
  const store = new MemoryConnectionStore();

  const account = connectedAccountRef({
    backend: "direct-x",
    platform: "x",
    accountId: "fixture-user",
  });

  const handler = connectionHandlers({
    backend: "direct-x",
    platforms: ["x"],
    redirectUri: "https://app.example.test/callback",
    store,
    provider: {
      async start(input) {
        return { authorizationUrl: `https://provider.example.test/authorize?state=${input.state}` };
      },
      async complete() {
        return [{ ref: account, displayName: "Fixture user" }];
      },
    },
  });

  const session = { tenantId: "tenant", principalId: "user" };
  const started = await handler.begin(session);

  const callback = {
    attemptId: started.attempt.id,
    returnedState: started.attempt.state,
    callbackUrl: `https://app.example.test/callback?state=${started.attempt.state}&code=fixture`,
    selectedAccountIds: [account.accountId],
  };

  await assert.rejects(handler.discover({ ...session, tenantId: "other" }, callback));
  assert.deepEqual((await handler.discover(session, callback))[0]?.ref, account);
  assert.deepEqual((await handler.select(session, callback))[0]?.account, account);
  await assert.rejects(handler.select(session, callback));
});

test("webhook recipe rejects invalid authentication and quarantines unknown accounts", async () => {
  const { receiveWebhook } = await import("./webhook-handler.js");
  const accepted: { state: string }[] = [];

  const input = {
    provider: "post-for-me" as const,
    backend: "managed",
    endpointId: "endpoint",
    secret: "fixture-secret",
    headers: new Headers({ "Post-For-Me-Webhook-Secret": "fixture-secret" }),
    rawBody: new TextEncoder().encode(
      JSON.stringify({
        event_type: "social.post.updated",
        data: { social_account_id: "unknown", status: "processed" },
      }),
    ),
    inbox: {
      async accept(record: { state: string }) {
        accepted.push(record);

        return "accepted" as const;
      },
    },
    async resolveTenants() {
      return [];
    },
  };

  await assert.rejects(receiveWebhook({ ...input, headers: new Headers() }));
  assert.equal(accepted.length, 0);
  assert.equal((await receiveWebhook(input)).quarantined, true);
  assert.equal(accepted[0]?.state, "quarantined");
});
