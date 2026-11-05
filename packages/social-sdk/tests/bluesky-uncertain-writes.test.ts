import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SocialError } from "../src/core/index.js";
import { account, did, harness, json } from "./bluesky-harness.js";

/**
 * A write whose response arrives but lacks a field the lexicon requires may already have
 * happened, so it must surface as an uncertain outcome and must not be retried.
 */
const uncertain = (error: SocialError) =>
  error instanceof SocialError &&
  error.code === "ambiguous_outcome" &&
  error.retryDisposition.kind === "reconcile-first";

const invalidInput = (error: SocialError) =>
  error instanceof SocialError && error.code === "invalid_input";

const recordRef = {
  uri: `at://${did}/app.bsky.actor.profile/self`,
  cid: "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
};

describe("Bluesky writes with a malformed success response", () => {
  it("sendMessageBatch without the required items is uncertain, not an empty success", async () => {
    const { native, calls } = harness(() => json({}));

    await assert.rejects(
      native.sendMessageBatch({ account, items: [{ conversationId: "convo-1", text: "hello" }] }),
      uncertain,
    );
    assert.equal(calls.length, 1);
  });

  it("sendMessageBatch still returns the confirmed items", async () => {
    const sent = { id: "msg-1", rev: "rev-1", text: "hello" };
    const { native } = harness(() => json({ items: [sent] }));

    assert.deepEqual(
      await native.sendMessageBatch({
        account,
        items: [{ conversationId: "convo-1", text: "hello" }],
      }),
      [sent],
    );
  });

  it("createDraft without the draft id is uncertain", async () => {
    const { native, calls } = harness(() => json({}));

    await assert.rejects(
      native.createDraft({ account, draft: { posts: [{ text: "hello" }] } }),
      uncertain,
    );
    assert.equal(calls.length, 1);
  });

  it("createGroupChat without the convo is uncertain", async () => {
    const { native, calls } = harness(() => json({}));

    await assert.rejects(
      native.createGroupChat({ account, name: "Team", members: ["did:plc:other"] }),
      uncertain,
    );
    assert.equal(calls.length, 1);
  });

  it("a procedure whose body is not an object is uncertain", async () => {
    const { native } = harness(() => json([]));

    await assert.rejects(
      native.createGroupChat({ account, name: "Team", members: ["did:plc:other"] }),
      uncertain,
    );
  });

  it("createAppPassword without the password is uncertain", async () => {
    const { native } = harness(() => json({ name: "ci", createdAt: "2026-11-05T00:00:00Z" }));

    await assert.rejects(native.createAppPassword({ account, name: "ci" }), uncertain);
  });

  it("markAllConversationsRead without updatedCount is uncertain", async () => {
    const { native } = harness(() => json({}));

    await assert.rejects(native.markAllConversationsRead({ account }), uncertain);
  });

  it("setLiveStatus without the record URI and CID is uncertain", async () => {
    const { native } = harness(() => json({}));

    await assert.rejects(
      native.setLiveStatus({ account, url: "https://stream.example/live", durationMinutes: 30 }),
      uncertain,
    );
  });

  it("editProfile without the written record reference is uncertain", async () => {
    const { native, calls } = harness((call) =>
      call.url.pathname.endsWith("getRecord")
        ? json({ uri: recordRef.uri, cid: recordRef.cid, value: { displayName: "Old" } })
        : json({}),
    );

    await assert.rejects(
      native.editProfile({ account, changes: { displayName: "New" } }),
      uncertain,
    );
    assert.equal(calls.length, 2);
  });
});

describe("Bluesky group chat names", () => {
  const convo = { id: "convo-1", rev: "rev-1", members: [] };

  it("rejects more than 50 graphemes before sending", async () => {
    const { native, calls } = harness(() => json({ convo }));

    await assert.rejects(
      native.createGroupChat({ account, name: "a".repeat(51), members: ["did:plc:other"] }),
      invalidInput,
    );
    await assert.rejects(
      native.renameGroupChat({ account, conversationId: "convo-1", name: "a".repeat(51) }),
      invalidInput,
    );
    assert.equal(calls.length, 0);
  });

  it("rejects more than 500 bytes before sending", async () => {
    const { native, calls } = harness(() => json({ convo }));
    // 21 family emoji: 21 graphemes, 525 UTF-8 bytes.
    const name = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}".repeat(21);

    await assert.rejects(
      native.createGroupChat({ account, name, members: ["did:plc:other"] }),
      invalidInput,
    );
    await assert.rejects(
      native.renameGroupChat({ account, conversationId: "convo-1", name }),
      invalidInput,
    );
    assert.equal(calls.length, 0);
  });

  it("accepts a 50-grapheme name", async () => {
    const { native, calls } = harness(() => json({ convo }));

    assert.deepEqual(
      await native.createGroupChat({ account, name: "a".repeat(50), members: ["did:plc:other"] }),
      convo,
    );
    assert.equal(calls[0]?.body?.["name"], "a".repeat(50));
  });
});
