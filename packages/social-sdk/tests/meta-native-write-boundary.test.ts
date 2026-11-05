import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectedAccountRef,
  type AdapterOperationContext,
  type DeliveryOutcome,
} from "../src/core/index.js";
import { SocialError } from "../src/core/errors.js";
import { facebook } from "../src/platforms/facebook.js";
import { instagram } from "../src/platforms/instagram.js";
import { threads } from "../src/platforms/threads.js";

// Offline regressions for the Meta uncertain-write boundary. After a write is dispatched, an
// HTTP 200 whose body fails the method's decoder may still mean the write took effect, so it
// must surface as ambiguous_outcome with reconcile-first after exactly one request. A 4xx is a
// definite refusal and must keep its definite classification.

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "write-boundary-offline",
  retryBudget: { maxAttempts: 3, maxElapsedMs: 10_000 },
};

const igAccount = connectedAccountRef({
  backend: "default",
  platform: "instagram",
  accountId: "123",
});

const threadsAccount = connectedAccountRef({
  backend: "default",
  platform: "threads",
  accountId: "u1",
});

const fbAccount = connectedAccountRef({
  backend: "default",
  platform: "facebook",
  accountId: "123",
});

/**
 * What a write did, as the test sees it: a publish path reports an uncertain write as an
 * `unknown` outcome, while other writes reject or return their value.
 */
type Settled =
  | { readonly kind: "rejected"; readonly error: SocialError }
  | { readonly kind: "resolved"; readonly state: DeliveryOutcome["state"] | "returned" };

const returned = (): Settled => ({ kind: "resolved", state: "returned" });

const outcome = (value: DeliveryOutcome): Settled => ({ kind: "resolved", state: value.state });

const settle = async (run: () => Promise<Settled>): Promise<Settled> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SocialError) return { kind: "rejected", error };

    throw error;
  }
};

const assertUncertain = (settled: Settled) => {
  if (settled.kind === "resolved") {
    assert.equal(settled.state, "unknown");

    return;
  }

  assert.equal(settled.error.code, "ambiguous_outcome");
  assert.deepEqual(settled.error.retryDisposition, { kind: "reconcile-first" });
};

const assertDefinite = (settled: Settled) => {
  if (settled.kind === "resolved") {
    assert.equal(settled.state, "failed");

    return;
  }

  assert.notEqual(settled.error.code, "ambiguous_outcome");
};

/** Answers every request with the same response and counts the requests. */
const recording = (answer: () => Response) => {
  let requests = 0;

  const fetch: typeof globalThis.fetch = async () => {
    requests++;

    return answer();
  };

  return { fetch, requests: () => requests };
};

const malformed: ReadonlyArray<readonly [label: string, answer: () => Response]> = [
  ["a non-object body", () => Response.json(["unexpected"])],
  ["an object without the documented fields", () => Response.json({ unexpected: true })],
];

const refused = () =>
  Response.json(
    { error: { message: "Invalid parameter", type: "OAuthException", code: 100 } },
    { status: 400 },
  );

interface WriteCase<Adapter> {
  readonly name: string;
  readonly run: (adapter: Adapter) => Promise<Settled>;
}

const table = <Adapter>(
  suite: string,
  build: (fetch: typeof globalThis.fetch) => Adapter,
  cases: ReadonlyArray<WriteCase<Adapter>>,
) =>
  describe(suite, () => {
    for (const write of cases) {
      for (const [label, answer] of malformed)
        it(`${write.name} treats HTTP 200 with ${label} as uncertain after one request`, async () => {
          const server = recording(answer);

          assertUncertain(await settle(() => write.run(build(server.fetch))));
          assert.equal(server.requests(), 1);
        });

      it(`${write.name} keeps a 4xx as a definite failure`, async () => {
        const server = recording(refused);

        assertDefinite(await settle(() => write.run(build(server.fetch))));
        assert.equal(server.requests(), 1);
      });
    }
  });

const igAdapter = (fetch: typeof globalThis.fetch) =>
  instagram({
    auth: { accessToken: "offline-token", accountId: "123", flavor: "facebook-login" },
    fetch,
  });

const igNative = (fetch: typeof globalThis.fetch) => {
  const native = igAdapter(fetch).native;

  assert.ok(native);

  return native;
};

table("Instagram native writes", igNative, [
  {
    name: "createComment",
    run: (native) =>
      native
        .createComment({ account: igAccount, mediaId: "1", text: "offline", context })
        .then(returned),
  },
  {
    name: "replyToMention",
    run: (native) =>
      native
        .replyToMention({ account: igAccount, mediaId: "1", text: "offline", context })
        .then(returned),
  },
  {
    name: "moderateComment",
    run: (native) =>
      native
        .moderateComment({ account: igAccount, commentId: "1", hidden: true, context })
        .then(returned),
  },
  {
    name: "deleteComment",
    run: (native) =>
      native.deleteComment({ account: igAccount, commentId: "1", context }).then(returned),
  },
  {
    name: "setCommentsEnabled",
    run: (native) =>
      native
        .setCommentsEnabled({ account: igAccount, mediaId: "1", enabled: false, context })
        .then(returned),
  },
  {
    name: "createUpcomingEvent",
    run: (native) =>
      native
        .createUpcomingEvent({
          account: igAccount,
          title: "Offline event",
          startTime: "2027-01-01T10:00:00Z",
          context,
        })
        .then(returned),
  },
  {
    name: "updateUpcomingEvent",
    run: (native) =>
      native
        .updateUpcomingEvent({
          account: igAccount,
          eventId: "1",
          title: "Renamed event",
          context,
        })
        .then(returned),
  },
  {
    name: "respondToCollaborationInvite",
    run: (native) =>
      native
        .respondToCollaborationInvite({
          account: igAccount,
          mediaId: "1",
          accept: true,
          context,
        })
        .then(returned),
  },
  {
    name: "createResumableUpload",
    run: (native) =>
      native
        .createResumableUpload({ account: igAccount, mediaType: "REELS", context })
        .then(returned),
  },
  {
    name: "publishReel",
    run: (native) =>
      native
        .publishReel({
          account: igAccount,
          videoUrl: "https://cdn.example.test/reel.mp4",
          context,
        })
        .then(outcome),
  },
  {
    name: "publishStory",
    run: (native) =>
      native
        .publishStory({
          account: igAccount,
          mediaUrl: "https://cdn.example.test/story.jpg",
          context,
        })
        .then(outcome),
  },
]);

const igComments = (fetch: typeof globalThis.fetch) => {
  const comments = igAdapter(fetch).comments;

  assert.ok(comments?.reply);

  return { reply: comments.reply };
};

table("Instagram comment replies", igComments, [
  {
    name: "comments.reply",
    run: (comments) =>
      comments
        .reply(
          {
            kind: "comment",
            version: 1,
            backend: "default",
            platform: "instagram",
            accountId: "123",
            postId: "1",
            commentId: "2",
          },
          { text: "offline" },
          context,
        )
        .then(returned),
  },
]);

const threadsAdapter = (fetch: typeof globalThis.fetch) =>
  threads({ auth: { userId: "u1", accessToken: "offline-token" }, fetch });

const threadsNative = (fetch: typeof globalThis.fetch) => {
  const native = threadsAdapter(fetch).native;

  assert.ok(native);

  return native;
};

table("Threads native writes", threadsNative, [
  {
    name: "quotePost",
    run: (native) =>
      native
        .quotePost({ account: threadsAccount, postId: "1", text: "offline", context })
        .then(returned),
  },
  {
    name: "repost",
    run: (native) =>
      native.repost({ account: threadsAccount, postId: "1", context }).then(returned),
  },
  {
    name: "deletePost",
    run: (native) =>
      native.deletePost({ account: threadsAccount, postId: "1", context }).then(returned),
  },
  {
    name: "hideReply",
    run: (native) =>
      native
        .hideReply({ account: threadsAccount, replyId: "1", hide: true, context })
        .then(returned),
  },
  {
    name: "managePendingReply",
    run: (native) =>
      native
        .managePendingReply({ account: threadsAccount, replyId: "1", approve: true, context })
        .then(returned),
  },
  {
    name: "deleteComment",
    run: (native) =>
      native.deleteComment({ account: threadsAccount, commentId: "1", context }).then(returned),
  },
]);

const threadsSurfaces = (fetch: typeof globalThis.fetch) => {
  const adapter = threadsAdapter(fetch);

  assert.ok(adapter.comments?.reply);
  assert.ok(adapter.posts);

  return { reply: adapter.comments.reply, publishTarget: adapter.posts.publishTarget };
};

table("Threads replies and publishing", threadsSurfaces, [
  {
    name: "comments.reply",
    run: (surface) =>
      surface
        .reply(
          {
            kind: "comment",
            version: 1,
            backend: "default",
            platform: "threads",
            accountId: "u1",
            postId: "1",
            commentId: "2",
          },
          { text: "offline" },
          context,
        )
        .then(returned),
  },
  {
    name: "posts.publishTarget",
    run: (surface) =>
      surface
        .publishTarget(
          { targetIndex: 0, targetKey: "t", account: threadsAccount, content: { text: "offline" } },
          context,
        )
        .then(outcome),
  },
]);

const facebookSurfaces = (fetch: typeof globalThis.fetch) => {
  const adapter = facebook({ auth: { accessToken: "offline-token", pageId: "123" }, fetch });

  assert.ok(adapter.comments?.reply);
  assert.ok(adapter.posts);

  return { reply: adapter.comments.reply, publishTarget: adapter.posts.publishTarget };
};

table("Facebook writes missed by the first sweep", facebookSurfaces, [
  {
    name: "comments.reply",
    run: (surface) =>
      surface
        .reply(
          {
            kind: "comment",
            version: 1,
            backend: "default",
            platform: "facebook",
            accountId: "123",
            postId: "1",
            commentId: "2",
          },
          { text: "offline" },
          context,
        )
        .then(returned),
  },
  {
    name: "feed publish",
    run: (surface) =>
      surface
        .publishTarget(
          { targetIndex: 0, targetKey: "t", account: fbAccount, content: { text: "offline" } },
          context,
        )
        .then(outcome),
  },
  {
    name: "single photo publish",
    run: (surface) =>
      surface
        .publishTarget(
          {
            targetIndex: 0,
            targetKey: "t",
            account: fbAccount,
            content: {
              text: "offline",
              media: [
                {
                  kind: "image",
                  source: { kind: "https-url", url: "https://cdn.example.test/a.jpg" },
                },
              ],
            },
          },
          context,
        )
        .then(outcome),
  },
]);
