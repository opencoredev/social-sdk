/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-readable-spacing -- compact mocked transport fixtures. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { connectedAccountRef, createSocial } from "../src/index.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });
const conversation = {
  kind: "conversation" as const,
  version: 1 as const,
  backend: "default",
  platform: "x" as const,
  accountId: "u1",
  conversationId: "c1",
};

it("lists X conversations and messages and sends through social.messages", async () => {
  const requests: { url: URL; method: string; body: string | undefined }[] = [];
  const social = createSocial({
    backend: x({
      auth: { userId: "u1", accessToken: "token" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body?.toString(),
        });
        if (url.pathname === "/2/dm_events")
          return Response.json({
            data: [
              { id: "e3", text: "latest", dm_conversation_id: "c1" },
              { id: "e2", text: "older", dm_conversation_id: "c1" },
              { id: "e1", text: "other", dm_conversation_id: "c2" },
            ],
            meta: { next_token: "next" },
          });
        if (url.pathname === "/2/dm_conversations/c1/dm_events")
          return Response.json({ data: [{ id: "e3", text: "latest" }], meta: {} });
        if (url.pathname === "/2/dm_conversations/c1/messages")
          return Response.json({ data: { dm_event_id: "e4", dm_conversation_id: "c1" } });
        return Response.json({ meta: {} });
      },
    }),
  });

  const conversations = await social.messages.listConversations(account, { limit: 20 });
  assert.deepEqual(
    conversations.items.map((item) => item["id"]),
    ["e3", "e1"],
  );
  assert.ok(conversations.nextCursor !== undefined);
  assert.equal(requests[0]?.url.searchParams.get("max_results"), "20");
  assert.equal(
    requests[0]?.url.searchParams.get("dm_event.fields"),
    "id,text,event_type,created_at,dm_conversation_id,attachments,entities",
  );
  assert.equal(requests[0]?.url.searchParams.get("expansions"), "sender_id,participant_ids");

  await social.messages.listConversations(account, {
    cursor: conversations.nextCursor,
    limit: 20,
  });
  assert.equal(requests[1]?.url.searchParams.get("pagination_token"), "next");

  const messages = await social.messages.listMessages(conversation);
  assert.equal(messages.items[0]?.["text"], "latest");
  assert.equal(messages.nextCursor, undefined);

  const sent = await social.messages.send(conversation, { text: "hi" });
  assert.deepEqual(sent, { data: { dm_event_id: "e4", dm_conversation_id: "c1" } });
  const send = requests.at(-1);
  assert.equal(send?.method, "POST");
  assert.deepEqual(JSON.parse(send?.body ?? "{}"), { text: "hi" });

  const available = social
    .capabilities()
    .default.capabilities.filter((entry) => entry.operation.startsWith("messages."))
    .map((entry) => `${entry.operation}:${entry.availability}`)
    .sort();
  assert.deepEqual(available, [
    "messages.conversation.write:available",
    "messages.group.write:available",
    "messages.read:available",
    "messages.write:available",
  ]);
});

it("returns an empty page for X conversations with no DMs", async () => {
  const social = createSocial({
    backend: x({
      auth: { userId: "u1", accessToken: "token" },
      fetch: async () => Response.json({ meta: { result_count: 0 } }),
    }),
  });
  assert.deepEqual(await social.messages.listConversations(account), { items: [] });
  assert.deepEqual(await social.messages.listMessages(conversation), { items: [] });
});

it("rejects X DMs with only an app bearer token", async () => {
  const social = createSocial({
    backend: x({
      auth: { userId: "u1" },
      appBearerToken: "app",
      fetch: async () => Response.json({ meta: {} }),
    }),
  });
  await assert.rejects(social.messages.listConversations(account), { code: "missing_permission" });
  await assert.rejects(social.messages.send(conversation, { text: "hi" }), {
    code: "missing_permission",
  });
});
