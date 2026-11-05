// SOC-37 write-confirmation sweep for Bluesky. Each write is confirmed only by the answer its
// lexicon documents (https://github.com/bluesky-social/atproto, lexicons at 31eb9a0, 2026-11-05)
// with XRPC's HTTP 200 (https://atproto.com/specs/xrpc). Every case sends one request: the
// documented answer resolves; malformed answers are `ambiguous_outcome` with `reconcile-first`.
// Fixtures are synthetic; no provider is called.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SocialError } from "../src/core/errors.js";
import type { JsonValue } from "../src/core/types.js";
import { refreshBlueskySession, type BlueskyNative } from "../src/platforms/bluesky.js";
import { account, did, harness, post } from "./bluesky-harness.js";

const uncertain = (error: SocialError) => {
  assert.ok(error instanceof SocialError);
  assert.equal(error.code, "ambiguous_outcome");
  assert.deepEqual(error.retryDisposition, { kind: "reconcile-first" });

  return true;
};

/** An answer: a JSON body (or no body) with a status. */
interface Answer {
  readonly body?: JsonValue;
  readonly status?: number;
}

const ok = (body: JsonValue): Answer => ({ body });

const respond = (answer: Answer) =>
  answer.body === undefined
    ? new Response(null, { status: answer.status ?? 200 })
    : Response.json(answer.body, { status: answer.status ?? 200 });

interface WriteCase {
  readonly name: string;
  readonly call: (native: BlueskyNative) => Promise<object | void>;
  readonly valid: Answer;
  readonly malformed: readonly Answer[];
}

const cid = "bafyreiwrittenrecordcid";

const record = (collection: string, rkey = "3kwritten") => ({
  uri: `at://${did}/${collection}/${rkey}`,
  cid,
});

/** Answers that a created record cannot be confirmed by. */
const unconfirmedRecord = (collection: string): readonly Answer[] => [
  { body: null },
  ok([]),
  ok({}),
  ok({ uri: `at://did:plc:other/${collection}/3kwritten`, cid }),
  ok({ uri: `at://${did}/app.bsky.feed.repost/3kwritten`, cid }),
  ok({ uri: `at://${did}/${collection}/3kwritten`, cid: "" }),
  ok({ uri: `at://${did}/${collection}/3kwritten` }),
  ok({ ...record(collection), commit: 7 }),
  ok({ ...record(collection), commit: { cid, rev: "" } }),
  ok({ ...record(collection), validationStatus: 1 }),
  { body: record(collection), status: 201 },
];

const message = (id: string, extra: Record<string, JsonValue> = {}) => ({
  id,
  rev: "rev-1",
  text: "hello",
  sender: { did },
  sentAt: "2026-11-05T00:00:00.000Z",
  ...extra,
});

const convo = (id: string, extra: Record<string, JsonValue> = {}) => ({
  id,
  rev: "rev-1",
  members: [],
  muted: true,
  unreadCount: 0,
  ...extra,
});

const writes: readonly WriteCase[] = [
  {
    name: "likePost (createRecord)",
    call: (native) => native.likePost({ account, post }),
    valid: ok({ ...record("app.bsky.feed.like"), commit: { cid, rev: "rev-1" } }),
    malformed: unconfirmedRecord("app.bsky.feed.like"),
  },
  {
    name: "follow (createRecord)",
    call: (native) => native.follow({ account, did: "did:plc:alice" }),
    valid: ok({ ...record("app.bsky.graph.follow"), validationStatus: "valid" }),
    malformed: unconfirmedRecord("app.bsky.graph.follow"),
  },
  {
    name: "deleteStarterPack (deleteRecord)",
    call: (native) =>
      native.deleteStarterPack({ account, uri: `at://${did}/app.bsky.graph.starterpack/3kpack` }),
    valid: ok({ commit: { cid, rev: "rev-2" } }),
    malformed: [
      { body: null },
      ok([]),
      ok({ commit: 7 }),
      ok({ commit: { cid: "", rev: "rev-2" } }),
      { body: {}, status: 202 },
    ],
  },
  {
    name: "mute (no output)",
    call: (native) => native.mute({ account, did: "did:plc:alice" }),
    valid: { body: null },
    malformed: [{ status: 202 }, { body: {}, status: 204 }],
  },
  {
    name: "createBookmark (no output)",
    call: (native) => native.createBookmark({ account, post }),
    valid: { body: null },
    malformed: [{ status: 201 }],
  },
  {
    name: "rejectJoinRequest (empty object output)",
    call: (native) =>
      native.rejectJoinRequest({ account, conversationId: "convo-1", member: "did:plc:alice" }),
    valid: ok({}),
    malformed: [{ body: null }, ok([]), ok("ok"), { body: {}, status: 202 }],
  },
  {
    name: "sendMessage",
    call: (native) => native.sendMessage({ account, conversationId: "convo-1", text: "hello" }),
    valid: ok(message("msg-1")),
    malformed: [
      ok({}),
      ok(message("")),
      ok(message("msg-1", { rev: 7 })),
      ok(message("msg-1", { text: 7 })),
      ok({ id: "msg-1", rev: "rev-1", text: "hello", sentAt: "2026-11-05T00:00:00.000Z" }),
      { body: null },
    ],
  },
  {
    name: "addReaction",
    call: (native) =>
      native.addReaction({ account, conversationId: "convo-1", messageId: "msg-1", value: "👍" }),
    valid: ok({ message: message("msg-1") }),
    malformed: [ok({ message: message("msg-2") }), ok(message("msg-1")), ok({ message: 7 })],
  },
  {
    name: "muteConversation",
    call: (native) => native.muteConversation({ account, conversationId: "convo-1" }),
    valid: ok({ convo: convo("convo-1") }),
    malformed: [
      ok({ convo: convo("convo-2") }),
      ok({ convo: convo("convo-1", { muted: "yes" }) }),
      ok({ convo: { id: "convo-1", rev: "rev-1" } }),
      ok({}),
    ],
  },
  {
    name: "leaveConversation",
    call: (native) => native.leaveConversation({ account, conversationId: "convo-1" }),
    valid: ok({ convoId: "convo-1", rev: "rev-1" }),
    malformed: [ok({ rev: "rev-1" }), ok({ convoId: "convo-2", rev: "rev-1" })],
  },
  {
    name: "deleteMessageForSelf",
    call: (native) =>
      native.deleteMessageForSelf({ account, conversationId: "convo-1", messageId: "msg-1" }),
    valid: ok({ id: "msg-1", rev: "rev-1", sender: { did }, sentAt: "2026-11-05T00:00:00.000Z" }),
    malformed: [
      ok({ id: "msg-2", rev: "rev-1", sender: { did }, sentAt: "2026-11-05T00:00:00.000Z" }),
      ok({ id: "msg-1" }),
      ok({}),
    ],
  },
  {
    name: "acceptConvo",
    call: (native) => native.acceptConvo({ account, conversationId: "convo-1" }),
    valid: ok({ rev: "rev-1" }),
    malformed: [ok({ rev: 7 }), ok({ rev: "" }), ok([])],
  },
  {
    name: "requestJoinGroupChat",
    call: (native) => native.requestJoinGroupChat({ account, code: "join-code" }),
    valid: ok({ status: "pending" }),
    malformed: [ok({ status: "maybe" }), ok({ status: "joined", convo: 7 }), ok({})],
  },
  {
    name: "createJoinLink",
    call: (native) =>
      native.createJoinLink({ account, conversationId: "convo-1", joinRule: "anyone" }),
    valid: ok({
      joinLink: {
        code: "join-code",
        enabledStatus: "enabled",
        requireApproval: false,
        joinRule: "anyone",
        createdAt: "2026-11-05T00:00:00.000Z",
      },
    }),
    malformed: [ok({ joinLink: { code: "join-code" } }), ok({ joinLink: "join-code" })],
  },
  {
    name: "createModerationReport",
    call: (native) =>
      native.createModerationReport({
        account,
        reasonType: "com.atproto.moderation.defs#reasonSpam",
        subject: { $type: "com.atproto.admin.defs#repoRef", did: "did:plc:spam" },
      }),
    valid: ok({
      id: 42,
      reasonType: "com.atproto.moderation.defs#reasonSpam",
      subject: { $type: "com.atproto.admin.defs#repoRef", did: "did:plc:spam" },
      reportedBy: did,
      createdAt: "2026-11-05T00:00:00.000Z",
    }),
    malformed: [
      ok({ id: 42 }),
      ok({ id: "42", reasonType: "x", subject: {}, reportedBy: did, createdAt: "t" }),
      ok({ id: 42, reasonType: "x", subject: {}, reportedBy: "did:plc:other", createdAt: "t" }),
      { body: null },
    ],
  },
  {
    name: "putActivitySubscription",
    call: (native) =>
      native.putActivitySubscription({
        account,
        subject: "did:plc:alice",
        post: true,
        reply: false,
      }),
    valid: ok({ subject: "did:plc:alice", activitySubscription: { post: true, reply: false } }),
    malformed: [
      ok({ subject: "did:plc:bob" }),
      ok({ subject: "did:plc:alice", activitySubscription: { post: "yes", reply: false } }),
    ],
  },
  {
    name: "applyWrites",
    call: (native) =>
      native.applyWrites({
        account,
        writes: [
          {
            action: "create",
            collection: "app.bsky.feed.like",
            rkey: "3klike",
            value: {
              $type: "app.bsky.feed.like",
              subject: post,
              createdAt: "2026-11-05T00:00:00Z",
            },
          },
          { action: "delete", collection: "app.bsky.feed.like", rkey: "3kold" },
        ],
      }),
    valid: ok({
      commit: { cid, rev: "rev-3" },
      results: [
        {
          $type: "com.atproto.repo.applyWrites#createResult",
          ...record("app.bsky.feed.like", "3klike"),
        },
        { $type: "com.atproto.repo.applyWrites#deleteResult" },
      ],
    }),
    malformed: [
      ok({ results: [record("app.bsky.feed.like", "3klike")] }),
      ok({ results: [record("app.bsky.feed.like", "3kother"), {}] }),
      ok({ results: [{ uri: `at://${did}/app.bsky.feed.like/3klike` }, {}] }),
      ok({ results: [{ ...record("app.bsky.feed.like", "3klike"), validationStatus: 1 }, {}] }),
      ok({ commit: { cid: "" } }),
      ok({ results: "none" }),
    ],
  },
];

describe("Bluesky writes are confirmed only by their documented answer", () => {
  for (const write of writes) {
    it(`${write.name}: the documented answer resolves after one request`, async () => {
      const { native, calls } = harness(() => respond(write.valid));

      await write.call(native);
      assert.equal(calls.length, 1);
    });

    for (const [index, answer] of write.malformed.entries())
      it(`${write.name}: malformed answer ${index + 1} is uncertain, sent once`, async () => {
        const { native, calls } = harness(() => respond(answer));

        await assert.rejects(write.call(native), uncertain);
        assert.equal(calls.length, 1);
      });
  }

  it("a refresh whose answer is not a session is uncertain, sent once", async () => {
    let requests = 0;

    await assert.rejects(
      refreshBlueskySession({
        service: "https://pds.example",
        refreshJwt: "fixture-refresh",
        fetch: async () => {
          requests++;

          return Response.json({
            did,
            handle: "a.test",
            accessJwt: "a",
            refreshJwt: "r",
            active: "yes",
          });
        },
      }),
      uncertain,
    );
    assert.equal(requests, 1);
  });
});

describe("Bluesky errors do not keep raw fetch failures", () => {
  it("a fetch failure that names the request URL is not kept as the cause", async () => {
    const secret = "private-query-value";

    const { native } = harness(() => {
      throw new Error(
        `connect failed for https://pds.example/xrpc/app.bsky.actor.getProfile?actor=${secret}`,
      );
    });

    await assert.rejects(native.likePost({ account, post }), (error: SocialError) => {
      assert.ok(error instanceof SocialError);
      assert.ok(!error.message.includes(secret));
      assert.ok(!String(error.cause ?? "").includes(secret));

      return true;
    });
  });
});
