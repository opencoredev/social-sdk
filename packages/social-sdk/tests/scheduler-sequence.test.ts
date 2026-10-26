import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SocialError,
  connectedAccountRef,
  createSocial,
  defineAdapter,
  platformPostRef,
  type CapabilityManifest,
  type ConnectedAccountRef,
  type DeliveryOutcome,
  type DeliveryRef,
  type PreparedPublishTarget,
  type PublishSequenceRequest,
} from "../src/index.js";
import {
  MemoryScheduleStore,
  SocialScheduler,
  scheduledOutcomes,
  outcomeRecovery,
} from "../src/server/index.js";
import { linkedin } from "../src/platforms/linkedin.js";
import { MemoryIdempotencyStore } from "../src/testing/index.js";

const start = new Date("2026-03-01T10:00:00.000Z");

const at = { kind: "instant" as const, at: "2026-03-01T11:00:00Z" };

const due = new Date("2026-03-01T11:00:00.000Z");

const manifest: CapabilityManifest = {
  schemaVersion: 1,
  backend: "test",
  apiRevision: "test-v1",
  runtime: ["node"],
  capabilities: [
    { operation: "posts.publish", platform: "*", availability: "available" },
    { operation: "posts.getDelivery", platform: "*", availability: "available" },
  ],
};

const alpha = connectedAccountRef({ backend: "default", platform: "x", accountId: "alpha" });

const beta = connectedAccountRef({ backend: "default", platform: "bluesky", accountId: "beta" });

interface Sent {
  readonly accountId: string;
  readonly text: string | undefined;
  readonly replyTo: string | undefined;
}

type Behavior = (
  target: PreparedPublishTarget,
  attempt: number,
) => BehaviorResult | Promise<BehaviorResult>;

type BehaviorResult = "publish" | "accept" | "unknown" | "fail";

/** Each account's behavior is chosen per call; accepted deliveries publish when `release` runs. */
function chainHarness(behavior: Behavior = () => "publish") {
  const sent: Sent[] = [];
  const attempts = new Map<string, number>();
  const accepted = new Map<string, { account: ConnectedAccountRef; released: boolean }>();
  let sequence = 0;

  const publishedOutcome = (
    account: ConnectedAccountRef,
    targetIndex: number,
    postId: string,
  ): DeliveryOutcome => ({
    state: "published",
    targetIndex,
    account,
    observedAt: start.toISOString(),
    post: platformPostRef({
      backend: "default",
      platform: account.platform,
      accountId: account.accountId,
      postId,
    }),
  });

  const adapter = defineAdapter({
    id: "test",
    capabilities: manifest,
    posts: {
      prepareTarget: () => [],
      async publishTarget(target: PreparedPublishTarget): Promise<DeliveryOutcome> {
        const key = `${target.account.accountId}:${target.content.text ?? ""}`;
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        sent.push({
          accountId: target.account.accountId,
          text: target.content.text,
          replyTo: target.replyTo?.postId,
        });
        const id = `${target.account.accountId}-${++sequence}`;

        const base = {
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: start.toISOString(),
        };

        switch (await behavior(target, attempt)) {
          case "publish":
            return publishedOutcome(target.account, target.targetIndex, id);
          case "accept": {
            const delivery: DeliveryRef = {
              kind: "delivery",
              version: 1,
              backend: "default",
              platform: target.account.platform,
              accountId: target.account.accountId,
              deliveryId: id,
            };

            accepted.set(id, { account: target.account, released: false });

            return { ...base, state: "accepted", delivery };
          }

          case "unknown":
            return { ...base, state: "unknown", reason: "unmapped-state" };
          case "fail":
            return {
              ...base,
              state: "failed",
              code: "upstream_failure",
              message: "temporary",
              retryDisposition: { kind: "after-delay", delayMs: 0 },
            };
        }
      },
      async getDelivery(ref: DeliveryRef): Promise<DeliveryOutcome> {
        const entry = accepted.get(ref.deliveryId);

        if (entry === undefined)
          throw new SocialError({
            code: "not_found",
            operation: "posts.getDelivery",
            message: "missing",
          });

        // Managed backends commonly report index 0 for a single delivery.
        return entry.released
          ? { ...publishedOutcome(entry.account, 0, ref.deliveryId), delivery: ref }
          : {
              state: "accepted",
              targetIndex: 0,
              account: entry.account,
              observedAt: start.toISOString(),
              delivery: ref,
            };
      },
    },
  });

  let now = start;
  const clock = () => now;

  const social = createSocial({
    recovery: outcomeRecovery(),
    backend: adapter,
    idempotencyStore: new MemoryIdempotencyStore(),
    clock,
  });

  const scheduler = new SocialScheduler({
    social,
    store: new MemoryScheduleStore(),
    clock,
    maxPolls: 3,
    pollIntervalMs: 60_000,
  });

  return {
    scheduler,
    sent,
    release: () => {
      for (const entry of accepted.values()) entry.released = true;
    },
    setNow: (value: Date) => {
      now = value;
    },
  };
}

function thread(
  items: readonly { readonly targets: readonly ConnectedAccountRef[]; readonly text: string }[],
): PublishSequenceRequest {
  return {
    items: items.map((item) => ({
      targets: item.targets.map((account) => ({ account })),
      content: { text: item.text },
    })),
    idempotencyKey: "thread-1",
    replyToPrevious: true,
  };
}

describe("scheduled reply chains", () => {
  test("each destination replies to its own published parent and keeps original indexes", async () => {
    const h = chainHarness();

    const job = await h.scheduler.schedule({
      work: {
        kind: "sequence",
        request: thread([
          { targets: [alpha, beta], text: "1/" },
          // Destination order differs per item; outcomes keep each item's own indexes.
          { targets: [beta, alpha], text: "2/" },
          { targets: [alpha, beta], text: "3/" },
        ]),
      },
      at,
    });

    assert.deepEqual(
      job.lanes.map((lane) => lane.steps.map((step) => step.targetIndexes[0])),
      [
        [0, 1, 0],
        [1, 0, 1],
      ],
    );

    h.setNow(due);
    const run = await h.scheduler.runDue({ now: due });
    assert.equal(run.jobs[0]?.status, "completed");
    assert.equal(h.sent.length, 6);

    for (const accountId of ["alpha", "beta"]) {
      const chain = h.sent.filter((entry) => entry.accountId === accountId);
      assert.deepEqual(
        chain.map((entry) => entry.text),
        ["1/", "2/", "3/"],
      );
      assert.equal(chain[0]?.replyTo, undefined);
      // The reply targets the post this destination created for the previous item.
      assert.match(chain[1]?.replyTo ?? "", new RegExp(`^${accountId}-`));
      assert.match(chain[2]?.replyTo ?? "", new RegExp(`^${accountId}-`));
      assert.notEqual(chain[1]?.replyTo, chain[2]?.replyTo);
    }

    const saved = await h.scheduler.get(job.id);
    const second = saved === undefined ? undefined : scheduledOutcomes(saved)[1];
    assert.deepEqual(
      second?.outcomes.map((outcome) => [outcome.targetIndex, outcome.account.accountId]),
      [
        [0, "beta"],
        [1, "alpha"],
      ],
    );
  });

  test("an accepted parent holds only its own chain until reconciliation publishes it", async () => {
    const h = chainHarness((target) =>
      target.account.accountId === "alpha" && target.content.text === "1/" ? "accept" : "publish",
    );

    const job = await h.scheduler.schedule({
      work: {
        kind: "sequence",
        request: thread([
          { targets: [alpha, beta], text: "1/" },
          { targets: [alpha, beta], text: "2/" },
        ]),
      },
      at,
    });

    h.setNow(due);
    const first = await h.scheduler.runDue({ now: due });
    assert.equal(first.jobs[0]?.status, "running");
    assert.deepEqual(
      h.sent.map((entry) => `${entry.accountId}:${entry.text}`),
      ["alpha:1/", "beta:1/", "beta:2/"],
    );

    // Polling before the parent publishes never sends a reply.
    const poll = new Date(due.getTime() + 60_000);
    h.setNow(poll);
    await h.scheduler.runDue({ now: poll });
    assert.equal(h.sent.length, 3);

    h.release();
    const later = new Date(poll.getTime() + 60_000);
    h.setNow(later);
    const done = await h.scheduler.runDue({ now: later });
    assert.equal(done.jobs[0]?.status, "completed");
    assert.equal(h.sent.length, 4);
    const reply = h.sent[3];
    assert.equal(reply?.accountId, "alpha");
    assert.match(reply?.replyTo ?? "", /^alpha-/);

    const saved = await h.scheduler.get(job.id);
    const root = saved === undefined ? undefined : scheduledOutcomes(saved)[0]?.outcomes[0];
    assert.equal(root?.state, "published");
    assert.equal(root?.targetIndex, 0);
  });

  test("an unknown parent is never replied to", async () => {
    const h = chainHarness((target) =>
      target.account.accountId === "alpha" && target.content.text === "1/" ? "unknown" : "publish",
    );

    const job = await h.scheduler.schedule({
      work: {
        kind: "sequence",
        request: thread([
          { targets: [alpha, beta], text: "1/" },
          { targets: [alpha, beta], text: "2/" },
        ]),
      },
      at,
    });

    for (let minute = 0; minute <= 5; minute++) {
      const now = new Date(due.getTime() + minute * 60_000);
      h.setNow(now);
      await h.scheduler.runDue({ now });
    }

    assert.deepEqual(
      h.sent.map((entry) => `${entry.accountId}:${entry.text}`),
      ["alpha:1/", "beta:1/", "beta:2/"],
    );
    assert.equal((await h.scheduler.get(job.id))?.status, "blocked");

    // A retry cannot resend an unknown write either.
    await h.scheduler.retryFailed(job.id);
    assert.equal(h.sent.length, 3);
  });

  test("retrying a failed parent continues its chain without resending other destinations", async () => {
    const h = chainHarness((target, attempt) =>
      target.account.accountId === "alpha" && target.content.text === "1/" && attempt === 1
        ? "fail"
        : "publish",
    );

    const job = await h.scheduler.schedule({
      work: {
        kind: "sequence",
        request: thread([
          { targets: [alpha, beta], text: "1/" },
          { targets: [alpha, beta], text: "2/" },
        ]),
      },
      at,
    });

    h.setNow(due);
    const first = await h.scheduler.runDue({ now: due });
    assert.equal(first.jobs[0]?.status, "blocked");
    assert.equal(h.sent.length, 3);

    const retried = await h.scheduler.retryFailed(job.id);
    assert.equal(retried?.status, "completed");
    assert.deepEqual(
      h.sent.map((entry) => `${entry.accountId}:${entry.text}`),
      ["alpha:1/", "beta:1/", "beta:2/", "alpha:1/", "alpha:2/"],
    );
    assert.equal(h.sent.filter((entry) => entry.accountId === "beta").length, 2);
  });

  test("a cancel during a retry reports the retried parent in flight", async () => {
    let release: () => void = () => {};

    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered: () => void = () => {};

    const retrying = new Promise<void>((resolve) => (entered = resolve));

    const h = chainHarness(async (target, attempt) => {
      if (target.account.accountId !== "alpha" || target.content.text !== "1/") return "publish";

      if (attempt === 1) return "fail";

      entered();
      await gate;

      return "publish";
    });

    const job = await h.scheduler.schedule({
      work: {
        kind: "sequence",
        request: thread([
          { targets: [alpha, beta], text: "1/" },
          { targets: [alpha, beta], text: "2/" },
        ]),
      },
      at,
    });

    h.setNow(due);
    await h.scheduler.runDue({ now: due });

    const retry = h.scheduler.retryFailed(job.id);
    await retrying;

    const cancelled = await h.scheduler.cancel(job.id);
    assert.equal(cancelled.state, "unresolved");
    assert.deepEqual(cancelled.state === "unresolved" ? cancelled.unresolved : [], [
      { itemIndex: 0, targetIndex: 0, reason: "in-flight" },
    ]);

    release();
    assert.equal((await retry)?.status, "cancel-unresolved");
    assert.deepEqual(
      h.sent.map((entry) => `${entry.accountId}:${entry.text}`),
      ["alpha:1/", "beta:1/", "beta:2/", "alpha:1/"],
    );

    // The retried parent published, so nothing can still publish and cancel settles.
    assert.equal((await h.scheduler.cancel(job.id)).state, "cancelled");
  });

  test("a non-chained sequence stops after a failed item by default", async () => {
    const h = chainHarness((target) =>
      target.content.text === "1/" && target.account.accountId === "beta" ? "fail" : "publish",
    );

    await h.scheduler.schedule({
      work: {
        kind: "sequence",
        request: {
          items: [
            { targets: [{ account: alpha }, { account: beta }], content: { text: "1/" } },
            { targets: [{ account: alpha }], content: { text: "2/" } },
          ],
          idempotencyKey: "plain",
        },
      },
      at,
    });

    h.setNow(due);
    const run = await h.scheduler.runDue({ now: due });
    assert.equal(run.jobs[0]?.status, "blocked");
    assert.equal(h.sent.length, 2);
  });

  test("LinkedIn chains fail preflight before any root post is stored or sent", async () => {
    let fetches = 0;

    const adapter = linkedin({
      auth: { accessToken: "fixture", author: "urn:li:person:member1" },
      apiVersion: "202609",
      fetch: async () => {
        fetches++;
        throw new Error("offline");
      },
    });

    const social = createSocial({
      recovery: outcomeRecovery(),
      backend: adapter,
      idempotencyStore: new MemoryIdempotencyStore(),
      clock: () => start,
    });

    const store = new MemoryScheduleStore();
    const scheduler = new SocialScheduler({ social, store, clock: () => start });

    const member = connectedAccountRef({
      backend: "default",
      platform: "linkedin",
      accountId: "urn:li:person:member1",
    });

    await assert.rejects(
      scheduler.schedule({
        id: "li-thread",
        work: {
          kind: "sequence",
          request: {
            ...thread([
              { targets: [member], text: "1/" },
              { targets: [member], text: "2/" },
            ]),
            idempotencyKey: "li",
          },
        },
        at,
      }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError &&
        error.code === "invalid_input" &&
        (error.issues ?? []).some((issue) => issue.path?.startsWith("items[1]") === true),
    );

    assert.equal(await scheduler.get("li-thread"), undefined);
    assert.equal(fetches, 0);
  });

  test("chains require the same destinations on every item", async () => {
    const h = chainHarness();

    await assert.rejects(
      h.scheduler.schedule({
        work: {
          kind: "sequence",
          request: thread([
            { targets: [alpha, beta], text: "1/" },
            { targets: [alpha], text: "2/" },
          ]),
        },
        at,
      }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && /same destination accounts/.test(error.message),
    );
  });
});
