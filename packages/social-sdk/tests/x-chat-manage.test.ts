import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import type { JsonValue } from "../src/core/types.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "x-chat-manage",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

interface Seen {
  readonly method: string;
  readonly href: string;
  readonly body: JsonValue | undefined;
  readonly form?: FormData;
}

function fake(
  routes: Readonly<Record<string, JsonValue>>,
  raw: Readonly<Record<string, () => Response>> = {},
) {
  const seen: Seen[] = [];

  const adapter = x({
    auth: { userId: "11", accessToken: "user" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (init?.body instanceof FormData)
        seen.push({ method, href: url.href, body: undefined, form: init.body });
      else
        seen.push({
          method,
          href: url.href,
          body:
            init?.body === undefined || init.body === null
              ? undefined
              : JSON.parse(String(init.body)),
        });

      const key = `${method} ${url.pathname}`;

      const respond = raw[key];

      if (respond !== undefined) return respond();

      const route = routes[key];

      return route === undefined
        ? Response.json({ title: "Not Found" }, { status: 404 })
        : Response.json(route);
    },
  });

  assert.ok(adapter.native);

  return { native: adapter.native, seen };
}

const signature = { message_id: "m1", message_event_signature: { signature: "c2ln" } };

it("creates an X Chat group at /2/chat/conversations/group from Chat XDK output", async () => {
  const { native, seen } = fake({
    "POST /2/chat/conversations/group/initialize": { data: { conversation_id: "g123" } },
    "POST /2/chat/conversations/group": {
      data: { conversation_id: "g123", conversation_key_change_sequence_id: "7" },
    },
  });

  const { conversationId } = await native.initializeChatGroup({ account, context });

  const created = await native.createChatGroup({
    account,
    group: {
      conversationId,
      conversationKeyVersion: "1730000000000",
      participantKeys: [
        { userId: "11", encryptedConversationKey: "a2V5MQ", publicKeyVersion: "1" },
        { userId: "12", encryptedConversationKey: "a2V5Mg", publicKeyVersion: "3" },
      ],
      memberIds: ["11", "12"],
      name: "ZW5jcnlwdGVk",
      messageTtlMs: 86_400_000,
      actionSignatures: [signature],
    },
    context,
  });

  assert.deepEqual(created, { conversationId: "g123", keyChangeSequenceId: "7" });
  assert.equal(seen[0]?.method, "POST");
  assert.deepEqual(seen[1]?.body, {
    conversation_id: "g123",
    conversation_key_version: "1730000000000",
    conversation_participant_keys: [
      { user_id: "11", encrypted_conversation_key: "a2V5MQ", public_key_version: "1" },
      { user_id: "12", encrypted_conversation_key: "a2V5Mg", public_key_version: "3" },
    ],
    group_members: ["11", "12"],
    group_name: "ZW5jcnlwdGVk",
    ttl_msec: "86400000",
    action_signatures: [signature],
  });
});

it("manages members, admins, admin requests, settings, invites and join requests", async () => {
  const { native, seen } = fake({
    "GET /2/chat/conversations/g123": { data: { id: "g123", type: "group" } },
    "PUT /2/chat/conversations/g123": { data: { updated: true } },
    "POST /2/chat/conversations/g123/members": { data: { id: "g123" } },
    "POST /2/chat/conversations/g123/members/remove": { data: { removed: true } },
    "POST /2/chat/conversations/g123/admins": { data: { added: true } },
    "POST /2/chat/conversations/g123/admins/remove": { data: { removed: true } },
    "GET /2/chat/conversations/g123/admin_requests": { data: [{ id: "13" }] },
    "POST /2/chat/conversations/g123/admin_requests": { data: { requested: true } },
    "POST /2/chat/conversations/g123/admin_requests/13/approve": { data: { approved: true } },
    "PUT /2/chat/conversations/g123/admin_settings": { data: { updated: true } },
    "POST /2/chat/conversations/g123/invite": {
      data: { invite_url: "https://x.com/i/chat/group_join/g123/AbCdEfGh12", token: "AbCdEfGh12" },
    },
    "DELETE /2/chat/conversations/g123/invite": { data: { disabled: true } },
    "GET /2/chat/conversations/g123/invites/AbCdEfGh12": { data: { member_count: 3 } },
    "POST /2/chat/conversations/g123/join_requests": { data: { requested: true } },
    "POST /2/chat/conversations/g123/join_requests/reject": { data: { rejected: true } },
    "DELETE /2/chat/conversations/g123": { data: { deleted: true } },
  });

  assert.equal(
    (await native.getChatConversation({ account, conversationId: "g123", context }))["type"],
    "group",
  );
  await native.updateChatGroup({
    account,
    conversationId: "g123",
    update: { modifiedFields: ["group_name"], conversationKeyVersion: "2", name: "bmV3" },
    context,
  });
  await native.addChatMembers({ account, conversationId: "g123", userIds: ["14"], context });
  await native.removeChatMembers({ account, conversationId: "g123", userIds: ["14"], context });
  await native.setChatAdmins({
    account,
    conversationId: "g123",
    userIds: ["12"],
    admin: true,
    context,
  });
  await native.setChatAdmins({
    account,
    conversationId: "g123",
    userIds: ["12"],
    admin: false,
    context,
  });
  assert.equal(
    (await native.chatAdminRequests({ account, conversationId: "g123", context })).items.length,
    1,
  );
  await native.requestChatAdmin({ account, conversationId: "g123", context });
  await native.resolveChatAdminRequest({
    account,
    conversationId: "g123",
    userId: "13",
    approve: true,
    context,
  });
  await native.updateChatAdminSettings({
    account,
    conversationId: "g123",
    settings: { sendMessage: true, editMessageTtl: false },
    context,
  });

  const invite = await native.enableChatInvite({
    account,
    conversationId: "g123",
    invite: {
      inviteUrl: "https://x.com/i/chat/group_join/g123/AbCdEfGh12",
      validForMs: 3_600_000,
      welcomeMessage: "Welcome",
    },
    context,
  });

  assert.equal(invite["token"], "AbCdEfGh12");
  await native.getChatInvite({ account, conversationId: "g123", token: "AbCdEfGh12", context });
  await native.requestToJoinChat({
    account,
    conversationId: "g123",
    token: "AbCdEfGh12",
    context,
  });
  await native.rejectChatJoinRequests({
    account,
    conversationId: "g123",
    userIds: ["15"],
    context,
  });
  await native.disableChatInvite({ account, conversationId: "g123", context });
  await native.deleteChatConversation({ account, conversationId: "g123", context });

  const byPath = (method: string, path: string) =>
    seen.find((request) => request.method === method && new URL(request.href).pathname === path);

  assert.deepEqual(byPath("PUT", "/2/chat/conversations/g123")?.body, {
    modified_fields: ["group_name"],
    conversation_key_version: "2",
    group_name: "bmV3",
  });
  assert.deepEqual(byPath("PUT", "/2/chat/conversations/g123/admin_settings")?.body, {
    edit_message_ttl: false,
    send_message: true,
  });
  assert.deepEqual(byPath("POST", "/2/chat/conversations/g123/invite")?.body, {
    invite_url: "https://x.com/i/chat/group_join/g123/AbCdEfGh12",
    validity_duration_msec: "3600000",
    welcome_message: "Welcome",
  });
  assert.deepEqual(byPath("POST", "/2/chat/conversations/g123/join_requests")?.body, {
    token: "AbCdEfGh12",
  });
  assert.deepEqual(byPath("POST", "/2/chat/conversations/g123/admins/remove")?.body, {
    user_ids: ["12"],
  });
});

it("raises ambiguous_outcome when X does not confirm a chat change", async () => {
  const { native } = fake({ "POST /2/chat/conversations/g123/admins": { data: { added: false } } });

  await assert.rejects(
    native.setChatAdmins({
      account,
      conversationId: "g123",
      userIds: ["12"],
      admin: true,
      context,
    }),
    { code: "ambiguous_outcome" },
  );
});

it("archives, mutes, marks read and sends typing on /2/chat/conversations/{id}/archive|mute|read|typing", async () => {
  const { native, seen } = fake({
    "POST /2/chat/conversations/11-12/archive": { data: { archived: true } },
    "DELETE /2/chat/conversations/11-12/archive": { data: { archived: false } },
    "POST /2/chat/conversations/11-12/mute": { data: { muted: true } },
    "DELETE /2/chat/conversations/11-12/mute": { data: { muted: false } },
    "POST /2/chat/conversations/11-12/read": { data: { success: true } },
    "POST /2/chat/conversations/11-12/unread": { data: { success: true } },
    "POST /2/chat/conversations/11-12/typing": { data: { success: true } },
  });

  const conversationId = "11-12";

  await native.setChatArchived({ account, conversationId, archived: true, context });
  await native.setChatArchived({ account, conversationId, archived: false, context });
  await native.setChatMuted({ account, conversationId, muted: true, context });
  await native.setChatMuted({ account, conversationId, muted: false, context });
  await native.markChatRead({
    account,
    conversationId,
    read: true,
    actionSignatures: [signature],
    context,
  });
  await native.markChatRead({ account, conversationId, read: false, context });
  await native.sendChatTyping({ account, conversationId, context });

  assert.deepEqual(
    seen.map((request) => `${request.method} ${new URL(request.href).pathname}`),
    [
      "POST /2/chat/conversations/11-12/archive",
      "DELETE /2/chat/conversations/11-12/archive",
      "POST /2/chat/conversations/11-12/mute",
      "DELETE /2/chat/conversations/11-12/mute",
      "POST /2/chat/conversations/11-12/read",
      "POST /2/chat/conversations/11-12/unread",
      "POST /2/chat/conversations/11-12/typing",
    ],
  );
  assert.deepEqual(seen[4]?.body, { action_signatures: [signature] });
});

it("sets message_ttl and screen capture, reads pinned_messages and deletes messages", async () => {
  const { native, seen } = fake({
    "PUT /2/chat/conversations/g123/message_ttl": { data: { updated: true } },
    "DELETE /2/chat/conversations/g123/message_ttl": { data: { deleted: true } },
    "PUT /2/chat/conversations/g123/screen_capture": {
      data: { blocking: true, detection: false },
    },
    "GET /2/chat/conversations/g123/pinned_messages": {
      data: [{ encoded_event: "ZXZlbnQ" }],
      meta: { next_token: "42" },
    },
    "POST /2/chat/conversations/g123/messages/delete": { data: { deleted: true } },
  });

  const conversationId = "g123";

  await native.setChatMessageTtl({ account, conversationId, ttlMs: 604_800_000, context });
  await native.setChatMessageTtl({ account, conversationId, ttlMs: undefined, context });

  assert.deepEqual(seen[0]?.body, { message_ttl_ms: "604800000" });
  assert.equal(seen[1]?.method, "DELETE");

  assert.deepEqual(
    await native.setChatScreenCapture({
      account,
      conversationId,
      blocking: true,
      detection: false,
      context,
    }),
    { blocking: true, detection: false },
  );

  const pinned = await native.chatPinnedMessages({ account, conversationId, context });

  assert.deepEqual(pinned.items, [{ encoded_event: "ZXZlbnQ" }]);
  assert.equal(pinned.nextCursor, "42");

  await native.deleteChatMessages({
    account,
    conversationId,
    sequenceIds: ["1800000000000000000"],
    scope: "delete_for_all",
    actionSignatures: [signature],
    context,
  });

  assert.deepEqual(seen[4]?.body, {
    sequence_ids: ["1800000000000000000"],
    delete_message_action: "delete_for_all",
    action_signatures: [signature],
  });
});

it("reads and registers /public_keys and adds conversation keys", async () => {
  const keys = {
    data: [{ public_key: "cGs", public_key_version: "1", signing_public_key: "c3Br" }],
  };

  const { native, seen } = fake({
    "GET /2/users/public_keys": keys,
    "GET /2/users/12/public_keys": keys,
    "POST /2/users/11/public_keys": { data: { public_key_version: "2" } },
    "POST /2/chat/conversations/g123/keys": {
      data: { conversation_id: "g123", sequence_id: "9" },
    },
  });

  assert.equal(
    (await native.chatPublicKeys({ account, userIds: ["12", "13"], context })).length,
    1,
  );
  assert.equal(new URL(seen[0]?.href ?? "").searchParams.get("ids"), "12,13");
  await native.chatPublicKeys({ account, userIds: ["12"], context });
  assert.equal(new URL(seen[1]?.href ?? "").pathname, "/2/users/12/public_keys");

  const registered = await native.registerChatPublicKey({
    account,
    publicKey: { public_key: "cGs", signing_public_key: "c3Br" },
    context,
  });

  assert.equal(registered["public_key_version"], "2");
  assert.deepEqual(seen[2]?.body, {
    public_key: { public_key: "cGs", signing_public_key: "c3Br" },
  });

  assert.deepEqual(
    await native.addChatConversationKeys({
      account,
      conversationId: "g123",
      conversationKeyVersion: "1730000000001",
      participantKeys: [{ userId: "12", encryptedConversationKey: "aw", publicKeyVersion: "1" }],
      context,
    }),
    { sequenceId: "9" },
  );
});

it("uploads encrypted media through /2/chat/media/upload and downloads it from /2/chat/media/", async () => {
  const { native, seen } = fake(
    {
      "POST /2/chat/media/upload/initialize": {
        data: {
          session_id: "1900000000000000000",
          media_hash_key: "abc123",
          conversation_id: "g123",
        },
      },
      "POST /2/chat/media/upload/1900000000000000000/append": { data: { expires_at: "soon" } },
      "POST /2/chat/media/upload/1900000000000000000/finalize": { data: { success: true } },
    },
    {
      "GET /2/chat/media/g123/abc123": () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "application/octet-stream" },
        }),
    },
  );

  const uploaded = await native.uploadChatMedia({
    account,
    conversationId: "g123",
    media: new Blob([new Uint8Array([9, 9, 9])]),
    messageId: "m1",
    context,
  });

  assert.deepEqual(uploaded, { mediaHashKey: "abc123", sessionId: "1900000000000000000" });
  assert.deepEqual(seen[0]?.body, { conversation_id: "g123", total_bytes: 3 });
  assert.equal(seen[1]?.form?.get("media_hash_key"), "abc123");
  assert.equal(seen[1]?.form?.get("segment_index"), "0");
  assert.deepEqual(seen[2]?.body, {
    conversation_id: "g123",
    media_hash_key: "abc123",
    num_parts: "1",
    message_id: "m1",
  });

  const downloaded = await native.downloadChatMedia({
    account,
    conversationId: "g123",
    mediaHashKey: "abc123",
    context,
  });

  assert.deepEqual([...downloaded.bytes], [1, 2, 3]);
});

it("lists and accepts /2/chat/message_requests and updates /2/chat/settings", async () => {
  const { native, seen } = fake({
    "GET /2/chat/message_requests": { data: [{ conversation_id: "11-12", sender_id: "12" }] },
    "GET /2/chat/message_requests/11-12": { data: { conversation_id: "11-12" } },
    "POST /2/chat/message_requests/11-12/accept": { data: { accepted: true } },
    "GET /2/chat/settings": { data: { allow_dms_from: "all" } },
    "PUT /2/chat/settings": { data: { allow_dms_from: "verified" } },
  });

  const requests = await native.chatMessageRequests({
    account,
    inboxType: "low_quality",
    limit: 50,
    context,
  });

  assert.equal(requests.items.length, 1);
  assert.equal(new URL(seen[0]?.href ?? "").searchParams.get("inbox_type"), "low_quality");
  await native.getChatMessageRequest({ account, conversationId: "11-12", context });
  await native.acceptChatMessageRequest({ account, conversationId: "11-12", context });

  assert.equal((await native.chatSettings({ account, context }))["allow_dms_from"], "all");
  assert.equal(
    (
      await native.chatSettings({
        account,
        settings: { allowMessagesFrom: "verified", readReceipts: "all_disabled" },
        context,
      })
    )["allow_dms_from"],
    "verified",
  );
  assert.deepEqual(seen[4]?.body, {
    allow_dms_from: "verified",
    dm_receipt_settings: "all_disabled",
  });
});

it("sends reaction_add and conversation_token and filters by participant_query", async () => {
  const { native, seen } = fake({
    "POST /2/chat/conversations/11-12/messages": { data: { encoded_message_event: "ZQ" } },
    "GET /2/chat/conversations": { data: [] },
  });

  await native.sendChatMessage({
    account,
    conversationId: "11-12",
    messageId: "m2",
    message: { kind: "reaction", eventId: "1800000000000000000", emoji: "🔥" },
    conversationToken: "tok",
    context,
  });

  assert.deepEqual(seen[0]?.body, {
    message_id: "m2",
    content: { reaction_add: { event_id: "1800000000000000000", emoji: "🔥" } },
    conversation_token: "tok",
  });

  await native.sendChatMessage({
    account,
    conversationId: "11-12",
    messageId: "m3",
    message: { kind: "reaction", eventId: "1800000000000000000", emoji: "🔥", remove: true },
    context,
  });

  assert.deepEqual(seen[1]?.body, {
    message_id: "m3",
    content: { reaction_remove: { event_id: "1800000000000000000", emoji: "🔥" } },
  });

  await native.chatConversations({ account, participantQuery: "ada", archived: false, context });

  const listUrl = new URL(seen[2]?.href ?? "");

  assert.equal(listUrl.searchParams.get("participant_query"), "ada");
  assert.equal(listUrl.searchParams.get("is_archived"), "false");
});
