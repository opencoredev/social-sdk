import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef, platformPostRef } from "../src/index.js";
import { zernio } from "../src/cloud/zernio.js";
import { postForMe } from "../src/cloud/post-for-me.js";

const account = connectedAccountRef({
  backend: "default",
  platform: "x",
  accountId: "victim-account",
});

const post = platformPostRef({ ...account, postId: "native-post" });

it("tenant denial prevents analytics, comments, messages, post reads, and account lookup requests", async () => {
  let calls = 0;

  const social = createSocial({
    backend: zernio({
      apiKey: "test",
      fetch: async () => {
        calls++;
        throw new Error("must not dispatch");
      },
    }),
    authorization: {
      async authorizeTargets(input) {
        return input.accounts.map((account) => ({ account, allowed: false }));
      },
    },
  });

  const conversation = {
    kind: "conversation" as const,
    version: 1 as const,
    backend: account.backend,
    platform: account.platform,
    accountId: account.accountId,
    conversationId: "c1",
  };

  const comment = {
    kind: "comment" as const,
    version: 1 as const,
    backend: account.backend,
    platform: account.platform,
    accountId: account.accountId,
    postId: "p1",
    commentId: "c1",
  };

  for (const action of [
    () => social.accounts.get(account),
    () => social.posts.get(post),
    () => social.analytics.getPostMetrics(post),
    () => social.comments.list(post),
    () => social.comments.reply(comment, { text: "reply" }),
    () => social.messages.listConversations(account),
    () => social.messages.listMessages(conversation),
    () => social.messages.send(conversation, { text: "message" }),
  ])
    await assert.rejects(
      action(),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "unauthorized",
    );
  assert.equal(calls, 0);
});

it("authorization for a different reference cannot authorize the requested account", async () => {
  let calls = 0;

  const social = createSocial({
    backend: zernio({
      apiKey: "test",
      fetch: async () => {
        calls++;

        return Response.json({});
      },
    }),
    authorization: {
      async authorizeTargets() {
        return [{ account: { ...account, accountId: "other" }, allowed: true }];
      },
    },
  });

  await assert.rejects(social.posts.get(post));
  assert.equal(calls, 0);
});

it("mixed-backend account discovery requires an explicit backend and cannot choose an arbitrary first key", async () => {
  const paths: string[] = [];

  const one = zernio({
    apiKey: "test",
    fetch: async (input) => {
      paths.push(String(input));

      return Response.json({ accounts: [], pagination: {} });
    },
  });

  const two = postForMe({
    apiKey: "test",
    fetch: async (input) => {
      paths.push(String(input));

      return Response.json({ data: [], meta: {} });
    },
  });

  const social = createSocial({ backends: { one, two } });
  await assert.rejects(social.accounts.list());
  assert.equal(paths.length, 0);
  await social.accounts.list({ backend: "two" });
  assert.equal(new URL(paths[0] ?? "").hostname, "api.postforme.dev");
});

it("missing managed messaging is an unsupported capability instead of an empty inbox", async () => {
  let calls = 0;

  const social = createSocial({
    backend: postForMe({
      apiKey: "test",
      fetch: async () => {
        calls++;
        throw new Error("must not run");
      },
    }),
  });

  await assert.rejects(
    social.messages.listConversations(account),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "unsupported_capability",
  );
  assert.equal(calls, 0);
});

it("account metric reads require tenant authorization before dispatch", async () => {
  const { createSocial } = await import("../src/index.js");
  const { mockBackend } = await import("../src/testing/index.js");
  const base = mockBackend();
  let calls = 0;

  const social = createSocial({
    backend: {
      ...base,
      capabilities: {
        ...base.capabilities,
        capabilities: [
          ...base.capabilities.capabilities,
          {
            operation: "analytics.account.read",
            platform: "*",
            availability: "available" as const,
          },
        ],
      },
      analytics: {
        ...base.analytics!,
        async getAccountMetrics() {
          calls++;

          return [];
        },
      },
    },
    authorization: {
      async authorizeTargets({ accounts }) {
        return accounts.map((account) => ({ account, allowed: false }));
      },
    },
  });

  await assert.rejects(
    social.analytics.getAccountMetrics({
      kind: "connected-account",
      version: 1,
      backend: "default",
      platform: "bluesky",
      accountId: "other",
    }),
    { code: "unauthorized" },
  );
  assert.equal(calls, 0);
});
