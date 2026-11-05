/**
 * Every LinkedIn write is confirmed only by its documented success answer. Each row sends one
 * write and gets one answer: the documented one resolves, and every malformed one (a JSON
 * `null`, an array, an empty object, a wrong-type ID, an invalid URN, or a success status other
 * than the documented one) is `ambiguous_outcome` with `reconcile-first`.
 * The sweep behind this table is in the SOC-37 write-confirmation notes.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { SocialError, type AdapterOperationContext } from "../src/index.js";
import type { JsonValue } from "../src/core/types.js";
import { linkedin, type LinkedInNative } from "../src/platforms/linkedin.js";

const author = "urn:li:organization:123";

const postId = "urn:li:share:123";

const parent = "urn:li:comment:(urn:li:activity:456,789)";

const replyUrn = "urn:li:comment:(urn:li:activity:456,790)";

const context = (): AdapterOperationContext => ({
  backendInstance: "default",
  correlationId: "write-confirmation",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
});

const account = {
  kind: "connected-account",
  version: 1,
  backend: "default",
  platform: "linkedin",
  accountId: author,
} as const;

function uncertain(error: SocialError): boolean {
  return (
    error instanceof SocialError &&
    error.code === "ambiguous_outcome" &&
    error.retryDisposition.kind === "reconcile-first"
  );
}

interface Answer {
  readonly name: string;
  readonly respond: () => Response;
}

const json = (name: string, body: JsonValue, status = 200): Answer => ({
  name,
  respond: () => Response.json(body, { status }),
});

const status = (code: number): Answer => ({
  name: `${code} without a body`,
  respond: () => new Response(null, { status: code }),
});

const restliId = (name: string, id: string | undefined, code = 201): Answer => ({
  name,
  respond: () =>
    new Response(null, { status: code, headers: id === undefined ? {} : { "x-restli-id": id } }),
});

/** Bodies that are not a usable resource. */
const notObjects: readonly Answer[] = [
  json("JSON null", null),
  json("array", []),
  json("empty object", {}),
];

/** Answers other than a post URN in x-restli-id. */
const notCreatedPosts: readonly Answer[] = [
  restliId("no x-restli-id", undefined),
  restliId("non-URN x-restli-id", "not-a-post-urn"),
  restliId("comment URN in x-restli-id", parent),
  restliId("incomplete post URN", "urn:li:share:"),
  json("JSON null", null, 201),
];

const createdPosts: readonly Answer[] = [
  restliId("share URN", "urn:li:share:99"),
  restliId("ugcPost URN", "urn:li:ugcPost:99"),
];

/** Every success answer except the given documented status without a body. */
const otherThan = (code: number): readonly Answer[] => [
  ...[200, 201, 202, 204].flatMap((other) => (other === code ? [] : [status(other)])),
  ...(code === 200 ? [] : notObjects),
];

/** Read answers for the preflight GETs of comments.reply. */
function read(url: URL): Response {
  if (url.pathname.startsWith("/rest/posts/")) return Response.json({ id: postId, author });

  return Response.json({ commentUrn: parent, object: "urn:li:activity:456" });
}

function setup(answer: Answer) {
  let writes = 0;

  const adapter = linkedin({
    auth: { accessToken: "fixture-only", author },
    apiVersion: "202610",
    fetch: async (input, init) => {
      if ((init?.method ?? "GET") === "GET") return read(new URL(String(input)));
      writes++;

      return answer.respond();
    },
  });

  return { adapter, writes: () => writes };
}

type Adapter = ReturnType<typeof linkedin>;

interface Write {
  readonly name: string;
  readonly run: (native: LinkedInNative, adapter: Adapter) => Promise<object | void>;
  readonly valid: readonly Answer[];
  readonly malformed: readonly Answer[];
}

const nativeOf = (adapter: Adapter): LinkedInNative => {
  assert.ok(adapter.native);

  return adapter.native;
};

const reaction = {
  id: "urn:li:reaction:(urn:li:organization:123,urn:li:activity:123)",
  reactionType: "LIKE",
  root: "urn:li:activity:123",
};

const writes: readonly Write[] = [
  // Normalized writes.
  {
    name: "posts.removeFromPlatform",
    run: (_native, adapter) => {
      assert.ok(adapter.posts?.removeFromPlatform);

      return adapter.posts.removeFromPlatform(
        { ...account, kind: "platform-post", postId },
        context(),
      );
    },
    valid: [status(204)],
    malformed: otherThan(204),
  },
  {
    name: "comments.reply",
    run: (_native, adapter) => {
      assert.ok(adapter.comments?.reply);

      return adapter.comments.reply(
        { ...account, kind: "comment", postId, commentId: parent },
        { text: "Reply" },
        context(),
      );
    },
    valid: [json("created comment", { commentUrn: replyUrn }, 201)],
    malformed: [
      ...notObjects,
      json("invalid commentUrn", { commentUrn: "not-a-comment-urn" }, 201),
      json("numeric commentUrn", { commentUrn: 7 }, 201),
    ],
  },
  // Posts API creates: the post URN in x-restli-id confirms them.
  {
    name: "createPoll",
    run: (native) =>
      native.createPoll({ account, text: "Q", options: ["A", "B"], context: context() }),
    valid: createdPosts,
    malformed: notCreatedPosts,
  },
  {
    name: "reshare",
    run: (native) => native.reshare({ account, postId, context: context() }),
    valid: createdPosts,
    malformed: notCreatedPosts,
  },
  {
    name: "createEventPost",
    run: (native) =>
      native.createEventPost({ account, reference: "urn:li:event:42", context: context() }),
    valid: createdPosts,
    malformed: notCreatedPosts,
  },
  // Writes with a documented status and no body to read.
  {
    name: "updatePost",
    run: (native) =>
      native.updatePost({ account, postId, body: { commentary: "Changed" }, context: context() }),
    valid: [status(204)],
    malformed: otherThan(204),
  },
  {
    name: "deletePost",
    run: (native) => native.deletePost({ account, postId, context: context() }),
    valid: [status(204)],
    malformed: otherThan(204),
  },
  {
    name: "deleteReaction",
    run: (native) => native.deleteReaction({ account, entity: postId, context: context() }),
    valid: [status(204)],
    malformed: otherThan(204),
  },
  {
    name: "setCommentsState",
    run: (native) =>
      native.setCommentsState({ account, postId, state: "CLOSED", context: context() }),
    valid: [status(202)],
    malformed: otherThan(202),
  },
  {
    name: "updateEvent",
    run: (native) =>
      native.updateEvent({
        account,
        event: "urn:li:event:42",
        changes: { name: "Updated" },
        context: context(),
      }),
    valid: [status(200)],
    malformed: otherThan(200),
  },
  {
    name: "unsubscribeOrganizationNotifications",
    run: (native) =>
      native.unsubscribeOrganizationNotifications({
        account,
        developerApplication: "urn:li:developerApplication:777",
        member: "urn:li:person:abCdef",
        context: context(),
      }),
    valid: [status(200)],
    malformed: otherThan(200),
  },
  // Writes whose page documents no status: a Rest.li success status with no body.
  {
    name: "deleteComment",
    run: (native) =>
      native.deleteComment({ account, postId, commentId: parent, context: context() }),
    valid: [status(204), status(200)],
    malformed: [
      json("array", []),
      json("empty object", {}),
      json("a resource", { id: "789" }),
      status(202),
    ],
  },
  {
    name: "subscribeOrganizationNotifications",
    run: (native) =>
      native.subscribeOrganizationNotifications({
        account,
        developerApplication: "urn:li:developerApplication:777",
        member: "urn:li:person:abCdef",
        webhook: "https://www.example.com/callback",
        context: context(),
      }),
    valid: [status(201), status(204)],
    malformed: [
      json("array", []),
      json("empty object", {}),
      json("a resource", { webhook: "https://www.example.com/callback" }),
      status(202),
    ],
  },
  // Writes that answer with the written resource.
  {
    name: "react",
    run: (native) => native.react({ account, postId, reaction: "LIKE", context: context() }),
    valid: [json("created reaction", reaction, 201)],
    malformed: [
      ...notObjects,
      json("JSON null at 201", null, 201),
      json("numeric id", { ...reaction, id: 7 }, 201),
      json("non-reaction id", { ...reaction, id: "urn:li:share:1" }, 201),
      json("other reaction type", { ...reaction, reactionType: "PRAISE" }, 201),
      json("numeric root", { ...reaction, root: 7 }, 201),
      json("reaction at 200", reaction),
    ],
  },
  {
    name: "createComment",
    run: (native) => native.createComment({ account, postId, text: "Hello", context: context() }),
    valid: [
      json("comment", { commentUrn: replyUrn, id: "790" }, 201),
      json("comment without id", { commentUrn: replyUrn }, 201),
    ],
    malformed: [
      ...notObjects,
      json("invalid commentUrn", { commentUrn: "not-a-comment-urn" }, 201),
      json("blank commentUrn", { commentUrn: "  " }, 201),
      json("numeric commentUrn", { commentUrn: 7 }, 201),
      json("numeric id", { commentUrn: replyUrn, id: 790 }, 201),
      json("id of another comment", { commentUrn: replyUrn, id: "999" }, 201),
    ],
  },
  {
    name: "editComment",
    run: (native) =>
      native.editComment({
        account,
        postId,
        commentId: parent,
        text: "Edited",
        context: context(),
      }),
    valid: [json("edited comment", { id: "789", message: { attributes: [], text: "Edited" } })],
    malformed: [
      ...notObjects,
      json("numeric id", { id: 789, message: { text: "Edited" } }),
      json("another comment", { id: "999", message: { text: "Edited" } }),
      json("null message", { id: "789", message: null }),
      status(204),
    ],
  },
  {
    name: "createEvent",
    run: (native) =>
      native.createEvent({
        account,
        name: "Launch",
        type: { kind: "external", endsAt: 9091536065000, url: "https://example.com/launch" },
        startsAt: 9091536064111,
        context: context(),
      }),
    valid: [
      json("event body", { id: "7249812613549670400", organizer: author }, 201),
      restliId("event URN header", "urn:li:event:7249812613549670400"),
    ],
    malformed: [
      json("JSON null", null, 201),
      json("array", [], 201),
      json("empty object", {}, 201),
      json("non-numeric id", { id: "abc" }, 201),
      json("negative id", { id: -1 }, 201),
      restliId("non-event header", "urn:li:share:1"),
      {
        name: "body and header naming different events",
        respond: () =>
          Response.json({ id: "1" }, { status: 201, headers: { "x-restli-id": "urn:li:event:2" } }),
      },
    ],
  },
];

for (const write of writes) {
  for (const answer of write.malformed)
    it(`LinkedIn ${write.name} keeps a ${answer.name} answer uncertain after one write`, async () => {
      const { adapter, writes: sent } = setup(answer);

      try {
        await assert.rejects(write.run(nativeOf(adapter), adapter), uncertain);
      } finally {
        assert.equal(sent(), 1);
      }
    });

  for (const answer of write.valid)
    it(`LinkedIn ${write.name} confirms its documented ${answer.name} after one write`, async () => {
      const { adapter, writes: sent } = setup(answer);

      await write.run(nativeOf(adapter), adapter);
      assert.equal(sent(), 1);
    });
}

// Council round 4 regression, ported from the reviewer's repro.
it("LinkedIn native createComment keeps malformed commentUrn uncertain", async () => {
  const { adapter, writes: sent } = setup(
    json("invalid commentUrn", { commentUrn: "not-a-comment-urn" }),
  );

  try {
    await assert.rejects(
      nativeOf(adapter).createComment({ account, postId, text: "fixture", context: context() }),
      uncertain,
    );
  } finally {
    assert.equal(sent(), 1);
  }
});
