import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { account, harness, json } from "./bluesky-harness.js";

const invalid = { name: "SocialError", code: "invalid_input" };

const proxy = "did:web:api.bsky.chat#bsky_chat";

const convo = {
  id: "convo-1",
  rev: "r1",
  members: [],
  muted: false,
  unreadCount: 0,
};

const link = {
  code: "join-abc",
  enabledStatus: "enabled",
  requireApproval: true,
  joinRule: "anyone",
  createdAt: "2026-11-04T00:00:00.000Z",
};

describe("Bluesky chat account data", () => {
  it("exports chat.bsky.actor.exportAccountData JSON Lines and deletes chat data", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("exportAccountData")
        ? new Response('{"kind":"convo","id":"c1"}\n{"kind":"message","id":"m1"}\n', {
            headers: { "content-type": "application/jsonl" },
          })
        : json({}),
    );

    const lines = await native.exportChatAccountData({ account });
    assert.deepEqual(lines, [
      { kind: "convo", id: "c1" },
      { kind: "message", id: "m1" },
    ]);
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.url.pathname, "/xrpc/chat.bsky.actor.exportAccountData");
    assert.equal(calls[0]?.headers.get("atproto-proxy"), proxy);
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer fixture");

    await native.deleteChatAccount({ account });
    assert.equal(calls[1]?.method, "POST");
    assert.equal(calls[1]?.url.pathname, "/xrpc/chat.bsky.actor.deleteAccount");
    assert.equal(calls[1]?.raw, undefined);
  });

  it("does not send an export whose signal was already aborted", async () => {
    const { native, calls } = harness(() => json({}));
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      native.exportChatAccountData({
        account,
        context: {
          backendInstance: "default",
          correlationId: "aborted-export",
          retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
          signal: controller.signal,
        },
      }),
      { code: "cancelled" },
    );
    assert.equal(calls.length, 0);
  });

  it("maps a rejected export to a SocialError", async () => {
    const { native } = harness(() => json({ error: "AuthRequired" }, 401));

    await assert.rejects(native.exportChatAccountData({ account }), { name: "SocialError" });
  });

  it("reads and writes chat.bsky.notification.putPreferences", async () => {
    const stored = {
      preferences: {
        chat: { include: "all", push: true },
        chatRequest: { include: "follows", push: false },
      },
    };

    const { native, calls } = harness(() => json(stored));

    assert.deepEqual(await native.getChatNotificationPreferences({ account }), stored.preferences);
    assert.equal(calls[0]?.url.pathname, "/xrpc/chat.bsky.notification.getPreferences");
    assert.equal(calls[0]?.headers.get("atproto-proxy"), proxy);

    await native.putChatNotificationPreferences({
      account,
      chatRequest: { include: "follows", push: false },
    });
    assert.equal(calls[1]?.url.pathname, "/xrpc/chat.bsky.notification.putPreferences");
    assert.deepEqual(calls[1]?.body, { chatRequest: { include: "follows", push: false } });

    await assert.rejects(native.putChatNotificationPreferences({ account }), invalid);
    assert.equal(calls.length, 2);
  });

  it("reads chat.bsky.convo.getUnreadCounts", async () => {
    const { native, calls } = harness(() =>
      json({ unreadAcceptedConvos: 3, unreadRequestConvos: 1 }),
    );

    assert.deepEqual(
      await native.getUnreadConversationCounts({ account, includeGroupChats: false }),
      { unreadAcceptedConvos: 3, unreadRequestConvos: 1 },
    );
    assert.equal(calls[0]?.url.pathname, "/xrpc/chat.bsky.convo.getUnreadCounts");
    assert.equal(calls[0]?.url.searchParams.get("includeGroupChats"), "false");
  });
});

describe("Bluesky group chat administration", () => {
  it("locks with chat.bsky.convo.lockConvo, pages members, and filters by lock status", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("getConvoMembers")
        ? json({ members: [{ did: "did:plc:a", handle: "a.test" }], cursor: "m2" })
        : url.pathname.endsWith("listConvos") || url.pathname.endsWith("listMutualGroups")
          ? json({ convos: [convo] })
          : json({ convo }),
    );

    assert.deepEqual(await native.lockGroupChat({ account, conversationId: "convo-1" }), convo);
    assert.equal(calls[0]?.url.pathname, "/xrpc/chat.bsky.convo.lockConvo");
    assert.deepEqual(calls[0]?.body, { convoId: "convo-1" });
    assert.equal(calls[0]?.headers.get("atproto-proxy"), proxy);

    await native.unlockGroupChat({ account, conversationId: "convo-1" });
    assert.equal(calls[1]?.url.pathname, "/xrpc/chat.bsky.convo.unlockConvo");

    const members = await native.getConvoMembers({ account, conversationId: "convo-1", limit: 20 });
    assert.equal(members.cursor, "m2");
    assert.equal(calls[2]?.url.pathname, "/xrpc/chat.bsky.convo.getConvoMembers");
    assert.equal(calls[2]?.url.searchParams.get("convoId"), "convo-1");
    assert.equal(calls[2]?.url.searchParams.get("limit"), "20");

    await native.listConversations({ account, kind: "group", lockStatus: "locked" });
    assert.equal(calls[3]?.url.searchParams.get("lockStatus"), "locked");

    const mutual = await native.listMutualGroups({ account, subject: "did:plc:friend" });
    assert.equal(mutual.items.length, 1);
    assert.equal(calls[4]?.url.pathname, "/xrpc/chat.bsky.group.listMutualGroups");
    assert.equal(calls[4]?.url.searchParams.get("subject"), "did:plc:friend");
  });

  it("manages join links with chat.bsky.group.createJoinLink and edits", async () => {
    const { native, calls } = harness(() => json({ joinLink: link }));

    assert.deepEqual(
      await native.createJoinLink({
        account,
        conversationId: "convo-1",
        joinRule: "anyone",
        requireApproval: true,
      }),
      link,
    );
    assert.equal(calls[0]?.url.pathname, "/xrpc/chat.bsky.group.createJoinLink");
    assert.deepEqual(calls[0]?.body, {
      convoId: "convo-1",
      joinRule: "anyone",
      requireApproval: true,
    });

    await native.editJoinLink({ account, conversationId: "convo-1", joinRule: "followedByOwner" });
    assert.deepEqual(calls[1]?.body, { convoId: "convo-1", joinRule: "followedByOwner" });

    await native.disableJoinLink({ account, conversationId: "convo-1" });
    await native.enableJoinLink({ account, conversationId: "convo-1" });
    assert.equal(calls[2]?.url.pathname, "/xrpc/chat.bsky.group.disableJoinLink");
    assert.equal(calls[3]?.url.pathname, "/xrpc/chat.bsky.group.enableJoinLink");

    await assert.rejects(native.editJoinLink({ account, conversationId: "convo-1" }), invalid);
    await assert.rejects(
      native.createJoinLink({
        account,
        conversationId: "convo-1",
        // @ts-expect-error: the lexicon only defines anyone and followedByOwner.
        joinRule: "everyone",
      }),
      invalid,
    );
    assert.equal(calls.length, 4);
  });

  it("previews, joins, and reviews join requests", async () => {
    const { native, calls } = harness(({ url }) => {
      if (url.pathname.endsWith("getJoinLinkPreviews"))
        return json({
          joinLinkPreviews: [
            { $type: "chat.bsky.group.defs#disabledJoinLinkPreviewView", code: "old" },
          ],
        });

      if (url.pathname.endsWith("requestJoin")) return json({ status: "pending" });

      if (url.pathname.endsWith("listJoinRequests"))
        return json({
          requests: [
            {
              convoId: "convo-1",
              requestedBy: { did: "did:plc:b", handle: "b.test" },
              requestedAt: "2026-11-04T00:00:00.000Z",
            },
          ],
        });

      if (url.pathname.endsWith("approveJoinRequest")) return json({ convo });

      return json({});
    });

    const previews = await native.getJoinLinkPreviews({ account, codes: ["old", "new"] });
    assert.equal(previews[0]?.["code"], "old");
    assert.deepEqual(calls[0]?.url.searchParams.getAll("codes"), ["old", "new"]);

    assert.deepEqual(await native.requestJoinGroupChat({ account, code: "join-abc" }), {
      status: "pending",
    });
    assert.deepEqual(calls[1]?.body, { code: "join-abc" });

    await native.withdrawJoinRequest({ account, conversationId: "convo-1" });
    assert.equal(calls[2]?.url.pathname, "/xrpc/chat.bsky.group.withdrawJoinRequest");

    const requests = await native.listJoinRequests({ account, conversationId: "convo-1" });
    assert.equal(requests.items.length, 1);

    assert.deepEqual(
      await native.approveJoinRequest({ account, conversationId: "convo-1", member: "did:plc:b" }),
      convo,
    );
    assert.equal(calls[4]?.url.pathname, "/xrpc/chat.bsky.group.approveJoinRequest");
    assert.deepEqual(calls[4]?.body, { convoId: "convo-1", member: "did:plc:b" });

    await native.rejectJoinRequest({ account, conversationId: "convo-1", member: "did:plc:c" });
    assert.equal(calls[5]?.url.pathname, "/xrpc/chat.bsky.group.rejectJoinRequest");

    await native.markJoinRequestsRead({ account, conversationId: "convo-1" });
    assert.equal(calls[6]?.url.pathname, "/xrpc/chat.bsky.group.updateJoinRequestsRead");

    await assert.rejects(
      native.approveJoinRequest({ account, conversationId: "convo-1", member: "b.test" }),
      invalid,
    );
    assert.equal(calls.length, 7);
  });

  it("shares a join link in a message as chat.bsky.embed.joinLink", async () => {
    const { native, calls } = harness(() =>
      json({
        id: "m1",
        rev: "r1",
        text: "Join us",
        sender: { did: "did:plc:test" },
        sentAt: "2026-11-04T00:00:00.000Z",
      }),
    );

    await native.sendMessage({
      account,
      conversationId: "convo-1",
      text: "Join us",
      embedJoinLink: "join-abc",
    });
    assert.deepEqual(calls[0]?.body, {
      convoId: "convo-1",
      message: { text: "Join us", embed: { $type: "chat.bsky.embed.joinLink", code: "join-abc" } },
    });

    await assert.rejects(
      native.sendMessage({
        account,
        conversationId: "convo-1",
        text: "Both",
        embedJoinLink: "join-abc",
        embedPost: { uri: "at://did:plc:a/app.bsky.feed.post/1", cid: "bafyreipostcid" },
      }),
      invalid,
    );
    assert.equal(calls.length, 1);
  });
});
