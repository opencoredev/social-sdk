import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { bluesky } from "../src/platforms/bluesky.js";
import {
  connectedAccountRef,
  SocialError,
  type JsonObject,
  type JsonValue,
} from "../src/core/index.js";
import { definedFields } from "../src/core/fields.js";
import { isJsonValue } from "../src/transport/json.js";
import { array, object } from "../src/transport/validation.js";

const did = "did:plc:test";

const account = connectedAccountRef({ backend: "default", platform: "bluesky", accountId: did });

const convo = { id: "convo-1", rev: "r1", members: [], muted: false, unreadCount: 0 };

const message = {
  id: "msg-1",
  rev: "r2",
  text: "hi",
  sender: { did },
  sentAt: "2026-01-01T00:00:00Z",
};

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly proxy: string | null;
  readonly body?: JsonObject;
}

function json(value: JsonValue): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function decode(body: BodyInit | null | undefined): JsonObject | undefined {
  if (body === undefined || body === null) return undefined;

  const parsed: unknown = JSON.parse(String(body));
  assert.ok(isJsonValue(parsed));

  return object(parsed);
}

function harness(routes: Readonly<Record<string, JsonValue>>) {
  const calls: Call[] = [];

  const adapter = bluesky({
    auth: { service: "https://pds.example", did, accessJwt: "fixture" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? "GET",
        url,
        proxy: new Headers(init?.headers).get("atproto-proxy"),
        ...definedFields({ body: decode(init?.body) }),
      });

      const route = routes[url.pathname.replace("/xrpc/", "")];
      assert.ok(route !== undefined, `unexpected request ${url.pathname}`);

      return json(route);
    },
  });

  return { native: adapter.native!, calls };
}

describe("Bluesky chat reads", () => {
  it("lists conversations with chat.bsky.convo.listConvos filters through the chat proxy", async () => {
    const { native, calls } = harness({
      "chat.bsky.convo.listConvos": { convos: [convo], cursor: "c2" },
    });

    const result = await native.listConversations({
      account,
      limit: 20,
      kind: "group",
      status: "accepted",
      unreadOnly: true,
    });

    assert.equal(result["cursor"], "c2");
    assert.equal(calls[0]?.url.pathname, "/xrpc/chat.bsky.convo.listConvos");
    assert.equal(calls[0]?.proxy, "did:web:api.bsky.chat#bsky_chat");
    assert.equal(calls[0]?.url.searchParams.get("kind"), "group");
    assert.equal(calls[0]?.url.searchParams.get("status"), "accepted");
    assert.equal(calls[0]?.url.searchParams.get("readState"), "unread");
    assert.equal(calls[0]?.url.searchParams.get("limit"), "20");
  });

  it("reads a page of chat.bsky.convo.getMessages for one conversation", async () => {
    const { native, calls } = harness({
      "chat.bsky.convo.getMessages": { messages: [message], cursor: "m2" },
    });

    const result = await native.listMessages({
      account,
      conversationId: "convo-1",
      cursor: "m1",
      limit: 10,
    });

    assert.deepEqual(array(result["messages"]), [message]);
    assert.equal(calls[0]?.url.searchParams.get("convoId"), "convo-1");
    assert.equal(calls[0]?.url.searchParams.get("cursor"), "m1");
    assert.equal(calls[0]?.proxy, "did:web:api.bsky.chat#bsky_chat");
  });

  it("reads incremental events with chat.bsky.convo.getLog", async () => {
    const { native, calls } = harness({
      "chat.bsky.convo.getLog": {
        logs: [{ $type: "chat.bsky.convo.defs#logCreateMessage", rev: "r3", convoId: "convo-1" }],
        cursor: "log-2",
      },
    });

    const log = await native.getChatLog({ account, cursor: "log-1" });

    assert.equal(log.cursor, "log-2");
    assert.equal(log.logs[0]?.["$type"], "chat.bsky.convo.defs#logCreateMessage");
    assert.equal(calls[0]?.url.searchParams.get("cursor"), "log-1");
  });
});

describe("Bluesky chat writes", () => {
  it("sends a message with link, tag, and mention facets and a shared post [feature:bluesky.messaging.send]", async () => {
    const { native, calls } = harness({ "chat.bsky.convo.sendMessage": message });

    const text = "@alice see https://example.com #sdk";
    const shared = { uri: "at://did:plc:alice/app.bsky.feed.post/3kpost", cid: "bafypostcid" };

    const sent = await native.sendMessage({
      account,
      conversationId: "convo-1",
      text,
      mentions: [{ byteStart: 0, byteEnd: 6, did: "did:plc:alice" }],
      embedPost: shared,
    });

    assert.equal(sent["id"], "msg-1");

    const body = calls[0]?.body;
    assert.equal(body?.["convoId"], "convo-1");

    const input = object(body?.["message"]);
    assert.equal(input["text"], text);
    assert.deepEqual(input["embed"], { $type: "app.bsky.embed.record", record: shared });

    const facets = array(input["facets"]).map((facet) => object(facet));
    assert.deepEqual(
      facets.map((facet) => object(array(facet["features"])[0])["$type"]),
      [
        "app.bsky.richtext.facet#mention",
        "app.bsky.richtext.facet#link",
        "app.bsky.richtext.facet#tag",
      ],
    );

    await assert.rejects(
      native.sendMessage({ account, conversationId: "convo-1", text: "x".repeat(10_001) }),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );
    assert.equal(calls.length, 1);
  });

  it("sends up to 100 messages with sendMessageBatch", async () => {
    const { native, calls } = harness({
      "chat.bsky.convo.sendMessageBatch": { items: [message, { ...message, id: "msg-2" }] },
    });

    const sent = await native.sendMessageBatch({
      account,
      items: [
        { conversationId: "convo-1", text: "one" },
        { conversationId: "convo-2", text: "two" },
      ],
    });

    assert.equal(sent.length, 2);
    assert.deepEqual(calls[0]?.body, {
      items: [
        { convoId: "convo-1", message: { text: "one" } },
        { convoId: "convo-2", message: { text: "two" } },
      ],
    });

    await assert.rejects(native.sendMessageBatch({ account, items: [] }));
  });

  it("starts a direct chat with getConvoForMembers after checking availability", async () => {
    const { native, calls } = harness({
      "chat.bsky.convo.getConvoAvailability": { canChat: true },
      "chat.bsky.convo.getConvoForMembers": { convo },
    });

    assert.deepEqual(await native.getConvoAvailability({ account, members: ["did:plc:bob"] }), {
      canChat: true,
    });
    assert.deepEqual(await native.getConvoForMembers({ account, members: ["did:plc:bob"] }), convo);
    assert.deepEqual(calls[1]?.url.searchParams.getAll("members"), ["did:plc:bob"]);

    await assert.rejects(native.getConvoForMembers({ account, members: ["bob.test"] }));
    assert.equal(calls.length, 2);
  });

  it("lists message requests with listConvoRequests and accepts one with acceptConvo", async () => {
    const { native, calls } = harness({
      "chat.bsky.convo.listConvoRequests": { requests: [convo], cursor: "q2" },
      "chat.bsky.convo.acceptConvo": { rev: "r9" },
    });

    const requests = await native.listConvoRequests({ account });
    assert.deepEqual(requests, { items: [convo], cursor: "q2" });

    assert.deepEqual(await native.acceptConvo({ account, conversationId: "convo-1" }), {
      rev: "r9",
    });
    assert.equal(calls[1]?.url.pathname, "/xrpc/chat.bsky.convo.acceptConvo");
    assert.deepEqual(calls[1]?.body, { convoId: "convo-1" });
  });

  it("adds and removes emoji reactions with chat.bsky.convo.addReaction and chat.bsky.convo.removeReaction", async () => {
    const { native, calls } = harness({
      "chat.bsky.convo.addReaction": { message },
      "chat.bsky.convo.removeReaction": { message },
    });

    const input = { account, conversationId: "convo-1", messageId: "msg-1", value: "👍🏽" };

    assert.deepEqual(await native.addReaction(input), message);
    await native.removeReaction(input);

    assert.deepEqual(
      calls.map((call) => [call.url.pathname, call.body]),
      [
        [
          "/xrpc/chat.bsky.convo.addReaction",
          { convoId: "convo-1", messageId: "msg-1", value: "👍🏽" },
        ],
        [
          "/xrpc/chat.bsky.convo.removeReaction",
          { convoId: "convo-1", messageId: "msg-1", value: "👍🏽" },
        ],
      ],
    );

    await assert.rejects(native.addReaction({ ...input, value: "ok" }));
    assert.equal(calls.length, 2);
  });

  it("manages read state, mutes, leaving, and deleteMessageForSelf", async () => {
    const { native, calls } = harness({
      "chat.bsky.convo.getConvo": { convo },
      "chat.bsky.convo.updateRead": { convo },
      "chat.bsky.convo.updateAllRead": { updatedCount: 4 },
      "chat.bsky.convo.muteConvo": { convo: { ...convo, muted: true } },
      "chat.bsky.convo.unmuteConvo": { convo },
      "chat.bsky.convo.leaveConvo": { convoId: "convo-1", rev: "r5" },
      "chat.bsky.convo.deleteMessageForSelf": {
        id: "msg-1",
        rev: "r6",
        sender: { did },
        sentAt: "x",
      },
    });

    const conversation = { account, conversationId: "convo-1" };

    assert.deepEqual(await native.getConversation(conversation), convo);
    await native.markConversationRead({ ...conversation, messageId: "msg-1" });
    assert.equal(await native.markAllConversationsRead({ account, status: "request" }), 4);
    assert.equal((await native.muteConversation(conversation))["muted"], true);
    await native.unmuteConversation(conversation);
    assert.deepEqual(await native.leaveConversation(conversation), { rev: "r5" });
    assert.equal(
      (await native.deleteMessageForSelf({ ...conversation, messageId: "msg-1" }))["id"],
      "msg-1",
    );

    assert.deepEqual(
      calls.map((call) => [call.method, call.url.pathname.replace("/xrpc/", ""), call.body]),
      [
        ["GET", "chat.bsky.convo.getConvo", undefined],
        ["POST", "chat.bsky.convo.updateRead", { convoId: "convo-1", messageId: "msg-1" }],
        ["POST", "chat.bsky.convo.updateAllRead", { status: "request" }],
        ["POST", "chat.bsky.convo.muteConvo", { convoId: "convo-1" }],
        ["POST", "chat.bsky.convo.unmuteConvo", { convoId: "convo-1" }],
        ["POST", "chat.bsky.convo.leaveConvo", { convoId: "convo-1" }],
        [
          "POST",
          "chat.bsky.convo.deleteMessageForSelf",
          { convoId: "convo-1", messageId: "msg-1" },
        ],
      ],
    );
    assert.ok(calls.every((call) => call.proxy === "did:web:api.bsky.chat#bsky_chat"));
  });

  it("creates, renames, and changes members of chat.bsky.group. group chats", async () => {
    const group = { ...convo, kind: { $type: "chat.bsky.convo.defs#groupConvo", name: "Team" } };

    const { native, calls } = harness({
      "chat.bsky.group.createGroup": { convo: group },
      "chat.bsky.group.editGroup": { convo: group },
      "chat.bsky.group.addMembers": { convo: group },
      "chat.bsky.group.removeMembers": { convo: group },
    });

    assert.deepEqual(
      await native.createGroupChat({ account, name: "Team", members: ["did:plc:a", "did:plc:b"] }),
      group,
    );
    await native.renameGroupChat({ account, conversationId: "convo-1", name: "Core team" });
    await native.addGroupChatMembers({
      account,
      conversationId: "convo-1",
      members: ["did:plc:c"],
    });
    await native.removeGroupChatMembers({
      account,
      conversationId: "convo-1",
      members: ["did:plc:a"],
    });

    assert.deepEqual(
      calls.map((call) => [call.url.pathname.replace("/xrpc/", ""), call.body]),
      [
        ["chat.bsky.group.createGroup", { name: "Team", members: ["did:plc:a", "did:plc:b"] }],
        ["chat.bsky.group.editGroup", { convoId: "convo-1", name: "Core team" }],
        ["chat.bsky.group.addMembers", { convoId: "convo-1", members: ["did:plc:c"] }],
        ["chat.bsky.group.removeMembers", { convoId: "convo-1", members: ["did:plc:a"] }],
      ],
    );

    await assert.rejects(
      native.createGroupChat({
        account,
        name: "Too many",
        members: Array.from({ length: 50 }, (_, index) => `did:plc:m${index}`),
      }),
    );
    await assert.rejects(native.createGroupChat({ account, name: " ", members: ["did:plc:a"] }));
    assert.equal(calls.length, 4);
  });
});
