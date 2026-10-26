import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  connectedAccountRef,
  createSocial,
  defineAdapter,
  type CapabilityManifest,
  type ConnectedAccountRef,
  type DeliveryOutcome,
  type PreparedPublishTarget,
  SocialError,
} from "../src/index.js";
import { zernio } from "../src/cloud/zernio.js";
import { postForMe } from "../src/cloud/post-for-me.js";
import { uploadPost } from "../src/cloud/upload-post.js";
import { outcomeRecovery } from "../src/server/index.js";
import { MemoryIdempotencyStore } from "../src/testing/index.js";

const manifest: CapabilityManifest = {
  schemaVersion: 1,
  backend: "test",
  apiRevision: "test-v1",
  runtime: ["bun"],
  capabilities: [{ operation: "posts.publish", platform: "*", availability: "available" }],
};

const alice = connectedAccountRef({ backend: "default", platform: "x", accountId: "alice" });

const bob = connectedAccountRef({ backend: "default", platform: "bluesky", accountId: "bob" });

/** Publishes every target and records the reply parent it received. */
function chainAdapter(fails: (target: PreparedPublishTarget) => boolean = () => false) {
  const sent: { account: string; text: string | undefined; parent: string | undefined }[] = [];

  const adapter = defineAdapter({
    id: "test",
    capabilities: manifest,
    posts: {
      prepareTarget: () => [],
      async publishTarget(target): Promise<DeliveryOutcome> {
        const parent = target.replyTo?.kind === "platform-post" ? target.replyTo.postId : undefined;
        sent.push({ account: target.account.accountId, text: target.content.text, parent });

        const base = {
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: "2026-10-24T12:00:00.000Z",
        };

        if (fails(target))
          return {
            ...base,
            state: "failed",
            code: "upstream_failure",
            message: "no",
            retryDisposition: { kind: "never" },
          };

        return {
          ...base,
          state: "published",
          post: {
            kind: "platform-post",
            version: 1,
            backend: target.account.backend,
            platform: target.account.platform,
            accountId: target.account.accountId,
            postId: `${target.account.accountId}:${target.content.text ?? ""}`,
          },
        };
      },
    },
  });

  return { adapter, sent };
}

/** Each destination's sends in order. Destinations publish concurrently, so only per-account order holds. */
function chains(
  sent: readonly { account: string; text: string | undefined; parent: string | undefined }[],
) {
  const byAccount: Record<string, [string | undefined, string | undefined][]> = {};

  for (const entry of sent) (byAccount[entry.account] ??= []).push([entry.text, entry.parent]);

  return byAccount;
}

const item = (text: string, accounts = [alice, bob]) => ({
  targets: accounts.map((account) => ({ account })),
  content: { text },
});

describe("multi-destination reply chains", () => {
  test("each destination replies to its own previous post", async () => {
    const { adapter, sent } = chainAdapter();
    const social = createSocial({ backend: adapter });

    const result = await social.posts.publishSequence({
      idempotencyKey: "thread",
      replyToPrevious: true,
      items: [item("1"), item("2"), item("3")],
    });

    assert.equal(result.status, "complete");
    assert.equal(result.items.length, 3);
    assert.deepEqual(chains(sent), {
      alice: [
        ["1", undefined],
        ["2", "alice:1"],
        ["3", "alice:2"],
      ],
      bob: [
        ["1", undefined],
        ["2", "bob:1"],
        ["3", "bob:2"],
      ],
    });
  });

  test("a broken chain stops only that destination and reports it as not submitted", async () => {
    const { adapter, sent } = chainAdapter(
      (target) => target.account.accountId === "bob" && target.content.text === "1",
    );

    const social = createSocial({ backend: adapter });

    const result = await social.posts.publishSequence({
      idempotencyKey: "thread-partial",
      replyToPrevious: true,
      stopOnFailure: false,
      items: [item("1"), item("2")],
    });

    assert.equal(result.status, "partial");
    assert.deepEqual(chains(sent), {
      alice: [
        ["1", undefined],
        ["2", "alice:1"],
      ],
      bob: [["1", undefined]],
    });

    const second = result.items[1];

    assert.equal(second?.status, "partial");
    assert.deepEqual(
      second?.outcomes.map((outcome) => [
        outcome.targetIndex,
        outcome.account.accountId,
        outcome.state,
      ]),
      [
        [0, "alice", "published"],
        [1, "bob", "not-submitted"],
      ],
    );

    const skipped = second?.outcomes[1];

    assert.equal(
      skipped?.state === "not-submitted" ? skipped.issues?.[0]?.code : undefined,
      "sequence.parent_unpublished",
    );
  });

  test("stops by default after an item with a failed destination", async () => {
    const { adapter, sent } = chainAdapter((target) => target.account.accountId === "bob");
    const social = createSocial({ backend: adapter });

    const result = await social.posts.publishSequence({
      idempotencyKey: "thread-stop",
      replyToPrevious: true,
      items: [item("1"), item("2")],
    });

    assert.equal(result.status, "partial");
    assert.equal(result.items.length, 1);
    assert.equal(sent.length, 2);
  });

  test("rejects chained targets without a parent account or with their own reply", async () => {
    const { adapter, sent } = chainAdapter();
    const social = createSocial({ backend: adapter });

    await assert.rejects(
      social.posts.publishSequence({
        idempotencyKey: "thread-new-account",
        replyToPrevious: true,
        items: [item("1", [alice]), item("2", [alice, bob])],
      }),
      { code: "invalid_input" },
    );

    await assert.rejects(
      social.posts.publishSequence({
        idempotencyKey: "thread-own-reply",
        replyToPrevious: true,
        items: [
          item("1"),
          {
            targets: [
              {
                account: alice,
                replyTo: {
                  kind: "platform-post",
                  version: 1,
                  backend: "default",
                  platform: "x",
                  accountId: "alice",
                  postId: "other",
                },
              },
            ],
            content: { text: "2" },
          },
        ],
      }),
      { code: "invalid_input" },
    );

    assert.equal(sent.length, 0);
  });

  test("allows a destination's chain to end before the others", async () => {
    const { adapter, sent } = chainAdapter();
    const social = createSocial({ backend: adapter });

    const result = await social.posts.publishSequence({
      idempotencyKey: "thread-shorter",
      replyToPrevious: true,
      items: [item("1"), item("2", [alice])],
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(sent.at(-1), { account: "alice", text: "2", parent: "alice:1" });
  });
});

describe("managed backend reply chains", () => {
  test("Zernio chains X replies through replyToTweetId", async () => {
    const bodies: unknown[] = [];
    let next = 0;

    const adapter = zernio({
      apiKey: "key",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        next += 1;

        return Response.json({
          post: {
            _id: `record-${next}`,
            status: "published",
            platforms: [
              {
                platform: "twitter",
                accountId: "acc",
                status: "published",
                platformPostId: `tweet-${next}`,
              },
            ],
          },
        });
      },
    });

    const social = createSocial({ backend: adapter });
    const x = connectedAccountRef({ backend: "default", platform: "x", accountId: "acc" });

    const result = await social.posts.publishSequence({
      idempotencyKey: "zernio-thread",
      replyToPrevious: true,
      items: [item("1", [x]), item("2", [x])],
    });

    assert.equal(result.status, "complete");
    assert.equal(JSON.stringify(bodies[0]).includes("replyToTweetId"), false);
    assert.deepEqual(bodies[1], {
      content: "2",
      mediaItems: [],
      platforms: [
        {
          platform: "twitter",
          accountId: "acc",
          platformSpecificData: { replyToTweetId: "tweet-1" },
        },
      ],
      publishNow: true,
    });
  });

  test("Upload-Post chains X and Bluesky text replies per destination", async () => {
    const replies: [string, string | null][] = [];
    let next = 0;

    const adapter = uploadPost({
      apiKey: "key",
      fetch: async (_input, init) => {
        const form = init?.body;

        if (!(form instanceof FormData)) throw new Error("expected multipart");
        const platform = String(form.get("platform[]"));
        const reply = form.get("reply_to_id");
        replies.push([platform, reply instanceof Blob || reply === null ? null : reply]);
        next += 1;

        return Response.json({
          success: true,
          results: { [platform]: { success: true, post_id: `${platform}-${next}` } },
        });
      },
    });

    const social = createSocial({ backend: adapter });
    const x = connectedAccountRef({ backend: "default", platform: "x", accountId: "brand" });

    const sky = connectedAccountRef({
      backend: "default",
      platform: "bluesky",
      accountId: "brand",
    });

    const result = await social.posts.publishSequence({
      idempotencyKey: "upload-post-thread",
      replyToPrevious: true,
      items: [item("1", [x, sky]), item("2", [x, sky])],
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(
      replies.slice(0, 2).map(([, reply]) => reply),
      [null, null],
    );

    const second = new Map(replies.slice(2));

    assert.equal(second.get("x"), replies[0]?.[0] === "x" ? "x-1" : "x-2");
    assert.equal(second.get("bluesky"), replies[0]?.[0] === "bluesky" ? "bluesky-1" : "bluesky-2");
  });

  test("backends without a documented reply mapping fail before any dispatch", async () => {
    let calls = 0;

    const adapter = postForMe({
      apiKey: "key",
      fetch: async () => {
        calls += 1;

        return Response.json({});
      },
    });

    const social = createSocial({ backend: adapter });
    const x = connectedAccountRef({ backend: "default", platform: "x", accountId: "acc" });

    let codes: readonly string[] = [];

    try {
      await social.posts.publishSequence({
        idempotencyKey: "post-for-me-thread",
        replyToPrevious: true,
        items: [item("1", [x]), item("2", [x])],
      });
    } catch (error) {
      if (error instanceof SocialError) codes = (error.issues ?? []).map((issue) => issue.code);
    }

    assert.ok(codes.includes("reply.use_comments"));
    assert.equal(calls, 0);
  });
});

test("a sequence replay after reconciling one chain continues it without a key conflict", async () => {
  let released = false;
  const sent: string[] = [];

  const posted = (
    account: ConnectedAccountRef,
    postId: string,
    targetIndex: number,
  ): DeliveryOutcome => ({
    state: "published",
    targetIndex,
    account,
    observedAt: "2026-10-24T12:00:00.000Z",
    post: {
      kind: "platform-post",
      version: 1,
      backend: account.backend,
      platform: account.platform,
      accountId: account.accountId,
      postId,
    },
  });

  const adapter = defineAdapter({
    id: "test",
    capabilities: {
      ...manifest,
      capabilities: [
        ...manifest.capabilities,
        { operation: "posts.getDelivery", platform: "*", availability: "available" },
      ],
    },
    posts: {
      prepareTarget: () => [],
      async publishTarget(target): Promise<DeliveryOutcome> {
        const text = target.content.text ?? "";
        sent.push(`${target.account.accountId}:${text}`);

        if (target.account.accountId !== "bob" || text !== "1")
          return posted(target.account, `${target.account.accountId}:${text}`, target.targetIndex);

        return {
          state: "accepted",
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: "2026-10-24T12:00:00.000Z",
          delivery: {
            kind: "delivery",
            version: 1,
            backend: "default",
            platform: "bluesky",
            accountId: "bob",
            deliveryId: "bob-root",
          },
        };
      },
      async getDelivery(ref): Promise<DeliveryOutcome> {
        return released
          ? { ...posted(bob, "bob:1", 0), delivery: ref }
          : {
              state: "processing",
              targetIndex: 0,
              account: bob,
              observedAt: "2026-10-24T12:00:00.000Z",
              delivery: ref,
            };
      },
    },
  });

  const social = createSocial({
    recovery: outcomeRecovery(),
    backend: adapter,
    idempotencyStore: new MemoryIdempotencyStore(),
  });

  const sequence = {
    idempotencyKey: "thread-recover",
    replyToPrevious: true,
    stopOnFailure: false,
    items: [item("1"), item("2")],
  };

  const first = await social.posts.publishSequence(sequence);
  assert.equal(first.status, "partial");
  assert.deepEqual(sent, ["alice:1", "bob:1", "alice:2"]);

  released = true;

  const root = await social.posts.reconcile({
    ...item("1"),
    idempotencyKey: "thread-recover:0",
  });

  assert.equal(root.status, "complete");

  const replay = await social.posts.publishSequence(sequence);
  assert.deepEqual(replay.failures, []);
  assert.equal(replay.status, "complete");
  assert.deepEqual(sent, ["alice:1", "bob:1", "alice:2", "bob:2"]);
  const reply = replay.items[1]?.outcomes[1];
  assert.equal(reply?.state, "published");
});

/** Refuses to save outcomes for one account, as a store outage limited to its claims would. */
class AccountFailingStore extends MemoryIdempotencyStore {
  constructor(private readonly accountId: string) {
    super();
  }

  override async saveOutcome(input: Parameters<MemoryIdempotencyStore["saveOutcome"]>[0]) {
    if (input.outcome.account.accountId === this.accountId) throw new Error("store unavailable");

    return super.saveOutcome(input);
  }
}

describe("persistence warnings in reply chains", () => {
  test("a per-destination item keeps the warning at the destination's index", async () => {
    const { adapter } = chainAdapter();

    const social = createSocial({
      backend: adapter,
      idempotencyStore: new AccountFailingStore("bob"),
    });

    const result = await social.posts.publishSequence({
      idempotencyKey: "thread-warn",
      replyToPrevious: true,
      items: [item("1"), item("2")],
    });

    assert.deepEqual(result.items[1]?.warnings, [
      { code: "idempotency-outcome-not-persisted", targetIndex: 1 },
    ]);
  });

  test("a partly submitted item maps its warning back to the original target", async () => {
    const { adapter } = chainAdapter(
      (target) => target.account.accountId === "alice" && target.content.text === "1",
    );

    const social = createSocial({
      backend: adapter,
      idempotencyStore: new AccountFailingStore("bob"),
    });

    const result = await social.posts.publishSequence({
      idempotencyKey: "thread-warn-partial",
      replyToPrevious: true,
      stopOnFailure: false,
      items: [item("1"), item("2")],
    });

    const second = result.items[1];

    assert.equal(second?.outcomes[0]?.state, "not-submitted");
    assert.deepEqual(second?.warnings, [
      { code: "idempotency-outcome-not-persisted", targetIndex: 1 },
    ]);
  });
});
