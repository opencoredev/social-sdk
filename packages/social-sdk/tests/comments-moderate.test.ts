import assert from "node:assert/strict";
import { it } from "node:test";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";
import { SocialError } from "../src/core/errors.js";
import { bluesky } from "../src/platforms/bluesky.js";
import { linkedin } from "../src/platforms/linkedin.js";
import { x } from "../src/platforms/x.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "fixture",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

const hasCode = (code: string) => (error: unknown) =>
  error instanceof SocialError && error.code === code;

const xAccount = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });

it("X hideReply sends PUT /2/tweets/:id/hidden and returns the reported state", async () => {
  const requests: Array<{ url: URL; method: string; body: unknown; auth: string | null }> = [];

  const adapter = x({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async (input, init) => {
      requests.push({
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      });

      return Response.json({ data: { hidden: false } });
    },
  });

  assert.deepEqual(
    await adapter.native!.hideReply({
      account: xAccount,
      replyId: "1346889436626259968",
      hidden: false,
      context,
    }),
    { hidden: false },
  );

  assert.equal(requests.length, 1);

  assert.equal(requests[0]?.method, "PUT");

  assert.equal(requests[0]?.url.pathname, "/2/tweets/1346889436626259968/hidden");

  assert.deepEqual(requests[0]?.body, { hidden: false });

  assert.equal(requests[0]?.auth, "Bearer token");

  const declared = adapter.capabilities.capabilities.find(
    (entry) => entry.operation === "comments.moderate",
  );

  assert.equal(declared?.availability, "available");

  assert.deepEqual(declared?.requiredScopes, ["tweet.moderate.write", "tweet.read", "users.read"]);
});

it("X hideReply rejects invalid IDs, foreign accounts, and app-only auth before any request", async () => {
  let calls = 0;

  const fetch = async () => {
    calls++;

    return Response.json({ data: { hidden: true } });
  };

  const adapter = x({ auth: { userId: "u1", accessToken: "token" }, fetch });

  await assert.rejects(
    adapter.native!.hideReply({ account: xAccount, replyId: "12/34", hidden: true, context }),
    hasCode("invalid_input"),
  );

  await assert.rejects(
    adapter.native!.hideReply({
      account: connectedAccountRef({ backend: "default", platform: "x", accountId: "u2" }),
      replyId: "1",
      hidden: true,
      context,
    }),
    hasCode("unauthorized"),
  );

  const appOnly = x({ auth: { userId: "u1" }, appBearerToken: "app", fetch });

  await assert.rejects(
    appOnly.native!.hideReply({ account: xAccount, replyId: "1", hidden: true, context }),
    hasCode("missing_permission"),
  );

  assert.equal(calls, 0);
});

it("X hideReply maps 403 to missing_permission and a missing state to ambiguous_outcome", async () => {
  const forbidden = x({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async () => Response.json({ title: "Forbidden" }, { status: 403 }),
  });

  await assert.rejects(
    forbidden.native!.hideReply({ account: xAccount, replyId: "1", hidden: true, context }),
    hasCode("missing_permission"),
  );

  const malformed = x({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async () => Response.json({ data: {} }),
  });

  await assert.rejects(
    malformed.native!.hideReply({ account: xAccount, replyId: "1", hidden: true, context }),
    hasCode("ambiguous_outcome"),
  );
});

const did = "did:plc:owner";

const bskyAccount = connectedAccountRef({
  backend: "default",
  platform: "bluesky",
  accountId: did,
});

const rootUri = `at://${did}/app.bsky.feed.post/root1`;

const replyUri = "at://did:plc:guest/app.bsky.feed.post/reply1";

const otherUri = "at://did:plc:guest/app.bsky.feed.post/reply0";

const threadgateUri = `at://${did}/app.bsky.feed.threadgate/root1`;

interface BlueskyCall {
  readonly method: string;
  readonly url: URL;
  readonly body?: Record<string, unknown>;
}

function blueskyWith(threadgate: Record<string, unknown> | undefined, replyRoot = rootUri) {
  const calls: BlueskyCall[] = [];

  const adapter = bluesky({
    auth: { service: "https://pds.example", did, accessJwt: "jwt" },
    fetch: async (input, init) => {
      const url = new URL(String(input));

      const body =
        init?.body === undefined
          ? undefined
          : (JSON.parse(String(init.body)) as Record<string, unknown>);
      calls.push({ method: init?.method ?? "GET", url, ...(body ? { body } : {}) });

      if (url.pathname.endsWith("app.bsky.feed.getPosts")) {
        const uri = url.searchParams.get("uris");

        if (uri === replyUri)
          return Response.json({
            posts: [
              {
                uri,
                cid: "reply-cid",
                record: {
                  text: "hi",
                  reply: {
                    root: { uri: replyRoot, cid: "root-cid" },
                    parent: { uri: replyRoot, cid: "root-cid" },
                  },
                },
              },
            ],
          });

        if (uri === rootUri)
          return Response.json({
            posts: [
              {
                uri,
                cid: "root-cid",
                record: { text: "root" },
                ...(threadgate === undefined ? {} : { threadgate }),
              },
            ],
          });

        return Response.json({ posts: [] });
      }

      return Response.json({ uri: threadgateUri, cid: "new-cid" });
    },
  });

  return { adapter, calls };
}

it("Bluesky hideReply creates a threadgate without an allow list when none exists", async () => {
  const { adapter, calls } = blueskyWith(undefined);

  const result = await adapter.native!.hideReply({
    account: bskyAccount,
    replyUri,
    hidden: true,
    context,
  });

  assert.deepEqual(result, { hidden: true, threadgate: { uri: threadgateUri, cid: "new-cid" } });

  assert.equal(calls.length, 3);

  const write = calls[2]!;

  assert.equal(write.method, "POST");

  assert.equal(write.url.pathname, "/xrpc/com.atproto.repo.createRecord");

  assert.equal(write.body?.["repo"], did);

  assert.equal(write.body?.["collection"], "app.bsky.feed.threadgate");

  assert.equal(write.body?.["rkey"], "root1");

  const record = write.body?.["record"] as Record<string, unknown>;

  assert.equal(record["$type"], "app.bsky.feed.threadgate");

  assert.equal(record["post"], rootUri);

  assert.deepEqual(record["hiddenReplies"], [replyUri]);

  assert.equal("allow" in record, false);
});

it("Bluesky hideReply updates an existing threadgate with swapRecord and keeps its rules", async () => {
  const existing = {
    uri: threadgateUri,
    cid: "gate-cid",
    record: {
      $type: "app.bsky.feed.threadgate",
      post: rootUri,
      createdAt: "2026-09-01T00:00:00.000Z",
      allow: [{ $type: "app.bsky.feed.threadgate#followingRule" }],
      hiddenReplies: [otherUri],
    },
  };

  const hide = blueskyWith(existing);

  await hide.adapter.native!.hideReply({ account: bskyAccount, replyUri, hidden: true, context });

  const put = hide.calls.at(-1)!;

  assert.equal(put.url.pathname, "/xrpc/com.atproto.repo.putRecord");

  assert.equal(put.body?.["rkey"], "root1");

  assert.equal(put.body?.["swapRecord"], "gate-cid");

  assert.deepEqual(put.body?.["record"], {
    ...existing.record,
    hiddenReplies: [otherUri, replyUri],
  });

  const unhide = blueskyWith({
    ...existing,
    record: { ...existing.record, hiddenReplies: [otherUri, replyUri] },
  });

  const result = await unhide.adapter.native!.hideReply({
    account: bskyAccount,
    replyUri,
    hidden: false,
    context,
  });

  assert.equal(result.hidden, false);

  const unhidePut = unhide.calls.at(-1)!;

  assert.equal(unhidePut.url.pathname, "/xrpc/com.atproto.repo.putRecord");

  assert.deepEqual(unhidePut.body?.["record"], {
    ...existing.record,
    hiddenReplies: [otherUri],
  });
});

it("Bluesky hideReply skips the write when the reply is already in the requested state", async () => {
  const none = blueskyWith(undefined);

  assert.deepEqual(
    await none.adapter.native!.hideReply({
      account: bskyAccount,
      replyUri,
      hidden: false,
      context,
    }),
    { hidden: false },
  );

  assert.ok(none.calls.every((call) => call.method === "GET"));

  const already = blueskyWith({
    uri: threadgateUri,
    cid: "gate-cid",
    record: { post: rootUri, createdAt: "2026-09-01T00:00:00.000Z", hiddenReplies: [replyUri] },
  });

  assert.deepEqual(
    await already.adapter.native!.hideReply({
      account: bskyAccount,
      replyUri,
      hidden: true,
      context,
    }),
    { hidden: true, threadgate: { uri: threadgateUri, cid: "gate-cid" } },
  );

  assert.ok(already.calls.every((call) => call.method === "GET"));
});

it("Bluesky hideReply refuses replies outside the account's threads and malformed URIs", async () => {
  const foreign = blueskyWith(undefined, "at://did:plc:guest/app.bsky.feed.post/root9");

  await assert.rejects(
    foreign.adapter.native!.hideReply({ account: bskyAccount, replyUri, hidden: true, context }),
    hasCode("invalid_input"),
  );

  assert.ok(foreign.calls.every((call) => call.method === "GET"));

  const { adapter, calls } = blueskyWith(undefined);

  await assert.rejects(
    adapter.native!.hideReply({
      account: bskyAccount,
      replyUri: "https://bsky.app/profile/guest/post/reply1",
      hidden: true,
      context,
    }),
    hasCode("invalid_input"),
  );

  await assert.rejects(
    adapter.native!.hideReply({
      account: bskyAccount,
      replyUri: rootUri,
      hidden: true,
      context,
    }),
    hasCode("invalid_input"),
  );

  await assert.rejects(
    adapter.native!.hideReply({
      account: connectedAccountRef({
        backend: "default",
        platform: "bluesky",
        accountId: "did:plc:x",
      }),
      replyUri,
      hidden: true,
      context,
    }),
    hasCode("unauthorized"),
  );

  assert.ok(calls.every((call) => call.method === "GET"));

  const declared = adapter.capabilities.capabilities.find(
    (entry) => entry.operation === "comments.moderate",
  );

  assert.equal(declared?.availability, "available");
});

it("LinkedIn declares comments.moderate unsupported by the platform", () => {
  const adapter = linkedin({
    auth: { accessToken: "secret", author: "urn:li:person:member1" },
    apiVersion: "202609",
  });

  const declared = adapter.capabilities.capabilities.find(
    (entry) => entry.operation === "comments.moderate",
  );

  assert.equal(declared?.availability, "unsupported-by-platform");

  assert.ok(declared?.notes);
});
