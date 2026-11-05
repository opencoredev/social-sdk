import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { facebook, facebookPageInboxAppId } from "../src/platforms/facebook.js";
import { decodePlatformWebhook } from "../src/server/webhooks.js";
import { isJsonValue } from "../src/transport/json.js";
import { isJsonObject } from "../src/transport/validation.js";
import type { AdapterOperationContext, JsonObject, JsonValue } from "../src/core/types.js";

// Offline contract tests for Messenger Platform features of the Facebook adapter. Every
// request goes to a fake fetch; nothing reaches Meta.

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const page = connectedAccountRef({ backend: "default", platform: "facebook", accountId: "123" });

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly json: JsonObject | undefined;
  readonly form: FormData | undefined;
}

function fake(responses: readonly JsonValue[]) {
  const calls: Call[] = [];
  let index = 0;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const raw = init?.body;
    let json: JsonObject | undefined;

    if (!(raw instanceof FormData) && !(raw instanceof Blob) && raw !== undefined && raw !== null) {
      const parsed: unknown = JSON.parse(String(raw));

      if (isJsonValue(parsed) && isJsonObject(parsed)) json = parsed;
    }

    calls.push({
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      json,
      form: raw instanceof FormData ? raw : undefined,
    });

    const response = responses[index++];

    if (response === undefined) throw new Error("Unexpected request");

    return Response.json(response);
  };

  const { native } = facebook({ auth: { pageId: "123", accessToken: "page-token" }, fetch });

  if (!native) throw new Error("The Facebook adapter has no native module");

  return { calls, native };
}

describe("facebook Messenger send options", () => {
  it("sends text and contact quick replies [feature:facebook.messaging.quick_replies]", async () => {
    const { calls, native } = fake([{ recipient_id: "456", message_id: "m_1" }]);

    await native.sendMessage({
      account: page,
      recipientId: "456",
      messagingType: "RESPONSE",
      text: "Pick a color",
      quickReplies: [
        {
          contentType: "text",
          title: "Red",
          payload: "COLOR_RED",
          imageUrl: "https://cdn.example.com/red.png",
        },
        { contentType: "user_email" },
      ],
      context,
    });

    assert.deepEqual(calls[0]?.json?.["message"], {
      text: "Pick a color",
      quick_replies: [
        {
          content_type: "text",
          title: "Red",
          payload: "COLOR_RED",
          image_url: "https://cdn.example.com/red.png",
        },
        { content_type: "user_email" },
      ],
    });
  });

  it("refuses more than 13 quick replies or a title over 20 characters [feature:facebook.messaging.quick_replies]", async () => {
    const { calls, native } = fake([]);
    const reply = { contentType: "text" as const, title: "Yes", payload: "Y" };

    await assert.rejects(
      native.sendMessage({
        account: page,
        recipientId: "456",
        messagingType: "RESPONSE",
        text: "Pick",
        quickReplies: Array.from({ length: 14 }, () => reply),
        context,
      }),
      /1 to 13 quick replies/,
    );

    await assert.rejects(
      native.sendMessage({
        account: page,
        recipientId: "456",
        messagingType: "RESPONSE",
        text: "Pick",
        quickReplies: [{ ...reply, title: "x".repeat(21) }],
        context,
      }),
      /1 to 20 characters/,
    );

    assert.equal(calls.length, 0);
  });

  it("sends reply_to, notification_type, metadata, and persona_id [feature:facebook.messaging.send_options]", async () => {
    const { calls, native } = fake([{ recipient_id: "456", message_id: "m_2" }]);

    const sent = await native.sendMessage({
      account: page,
      recipientId: "456",
      messagingType: "RESPONSE",
      text: "Quoted answer",
      replyToMessageId: "m_original",
      notificationType: "SILENT_PUSH",
      metadata: "ticket-42",
      personaId: "789",
      context,
    });

    assert.equal(sent.messageId, "m_2");
    assert.equal(calls[0]?.url.pathname, "/v27.0/123/messages");
    assert.deepEqual(calls[0]?.json, {
      recipient: { id: "456" },
      messaging_type: "RESPONSE",
      notification_type: "SILENT_PUSH",
      reply_to: { mid: "m_original" },
      persona_id: "789",
      message: { text: "Quoted answer", metadata: "ticket-42" },
    });
  });

  it("refuses metadata over 1,000 characters before sending [feature:facebook.messaging.send_options]", async () => {
    const { calls, native } = fake([]);

    await assert.rejects(
      native.sendMessage({
        account: page,
        recipientId: "456",
        messagingType: "RESPONSE",
        text: "Hi",
        notificationType: "NO_PUSH",
        metadata: "x".repeat(1001),
        context,
      }),
      /1,000 characters/,
    );

    assert.equal(calls.length, 0);
  });
});

describe("facebook Messenger sender actions", () => {
  it("sends typing_on with a persona and react/unreact payloads [feature:facebook.messaging.sender_actions]", async () => {
    const { calls, native } = fake([
      { recipient_id: "456" },
      { recipient_id: "456" },
      { recipient_id: "456" },
    ]);

    const typing = await native.sendSenderAction({
      account: page,
      recipientId: "456",
      action: "typing_on",
      personaId: "789",
      context,
    });

    await native.sendSenderAction({
      account: page,
      recipientId: "456",
      action: "react",
      messageId: "m_abc",
      reaction: "😊",
      context,
    });

    await native.sendSenderAction({
      account: page,
      recipientId: "456",
      action: "unreact",
      messageId: "m_abc",
      context,
    });

    assert.deepEqual(typing, { recipientId: "456" });
    assert.deepEqual(calls[0]?.json, {
      recipient: { id: "456" },
      sender_action: "typing_on",
      persona_id: "789",
    });
    assert.deepEqual(calls[1]?.json, {
      recipient: { id: "456" },
      sender_action: "react",
      payload: { message_id: "m_abc", reaction: "😊" },
    });
    assert.deepEqual(calls[2]?.json, {
      recipient: { id: "456" },
      sender_action: "unreact",
      payload: { message_id: "m_abc" },
    });
  });
});

describe("facebook Messenger personas", () => {
  it("creates, lists, and deletes personas [feature:facebook.messaging.personas]", async () => {
    const { calls, native } = fake([
      { id: "789" },
      {
        data: [{ id: "789", name: "Ada L.", profile_picture_url: "https://cdn.example.com/a.jpg" }],
      },
      { success: true },
    ]);

    const created = await native.createPersona({
      account: page,
      name: "Ada L.",
      profilePictureUrl: "https://cdn.example.com/a.jpg",
      context,
    });

    const listed = await native.listPersonas({ account: page, context });

    await native.deletePersona({ account: page, personaId: "789", context });

    assert.deepEqual(created, { id: "789" });
    assert.equal(calls[0]?.url.pathname, "/v27.0/123/personas");
    assert.deepEqual(calls[0]?.json, {
      name: "Ada L.",
      profile_picture_url: "https://cdn.example.com/a.jpg",
    });
    assert.deepEqual(listed.items, [
      { id: "789", name: "Ada L.", profilePictureUrl: "https://cdn.example.com/a.jpg" },
    ]);
    assert.equal(calls[2]?.method, "DELETE");
    assert.equal(calls[2]?.url.pathname, "/v27.0/789");
  });

  it("refuses a persona name over 50 characters [feature:facebook.messaging.personas]", async () => {
    const { calls, native } = fake([]);

    await assert.rejects(
      native.createPersona({
        account: page,
        name: "x".repeat(51),
        profilePictureUrl: "https://cdn.example.com/a.jpg",
        context,
      }),
      /1 to 50 characters/,
    );

    assert.equal(calls.length, 0);
  });
});

describe("facebook Messenger attachments and profiles", () => {
  it("uploads a reusable attachment by URL and by file [feature:facebook.messaging.attachment_upload]", async () => {
    const { calls, native } = fake([{ attachment_id: "111" }, { attachment_id: "222" }]);

    const byUrl = await native.uploadMessageAttachment({
      account: page,
      type: "image",
      url: "https://cdn.example.com/card.png",
      context,
    });

    const byFile = await native.uploadMessageAttachment({
      account: page,
      type: "file",
      file: new Blob(["pdf"], { type: "application/pdf" }),
      context,
    });

    assert.deepEqual(byUrl, { attachmentId: "111" });
    assert.deepEqual(byFile, { attachmentId: "222" });
    assert.equal(calls[0]?.url.pathname, "/v27.0/123/message_attachments");
    assert.deepEqual(calls[0]?.json, {
      message: {
        attachment: {
          type: "image",
          payload: { url: "https://cdn.example.com/card.png", is_reusable: true },
        },
      },
    });
    assert.equal(
      calls[1]?.form?.get("message"),
      JSON.stringify({ attachment: { type: "file", payload: { is_reusable: true } } }),
    );
    assert.ok(calls[1]?.form?.get("filedata") instanceof Blob);
  });

  it("reads first_name, last_name, and profile_pic for a PSID [feature:facebook.messaging.user_profile]", async () => {
    const { calls, native } = fake([
      {
        id: "456",
        first_name: "Ada",
        last_name: "Example",
        profile_pic: "https://cdn.example.com/p.jpg",
        email: "dropped@example.com",
      },
    ]);

    const profile = await native.getUserProfile({ account: page, userId: "456", context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/456");
    assert.equal(calls[0]?.url.searchParams.get("fields"), "id,first_name,last_name,profile_pic");
    assert.deepEqual(profile, {
      id: "456",
      first_name: "Ada",
      last_name: "Example",
      profile_pic: "https://cdn.example.com/p.jpg",
    });
  });

  it("filters conversations by user_id and folder [feature:facebook.messaging.conversations.filters]", async () => {
    const { calls, native } = fake([
      { data: [{ id: "t_1", updated_time: "2026-11-01T00:00:00+0000", participants: [] }] },
    ]);

    const result = await native.listConversations({
      account: page,
      userId: "456",
      folder: "page_done",
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/conversations");
    assert.equal(calls[0]?.url.searchParams.get("platform"), "messenger");
    assert.equal(calls[0]?.url.searchParams.get("user_id"), "456");
    assert.equal(calls[0]?.url.searchParams.get("folder"), "page_done");
    assert.equal(result.items.length, 1);
  });

  it("reads a message with attachments, a sticker, shares, story, tags, and reactions [feature:facebook.messaging.message_detail]", async () => {
    const { calls, native } = fake([
      {
        id: "m_9",
        message: "",
        created_time: "2026-11-01T00:00:00+0000",
        from: { id: "456", name: "Ada", email: "dropped@example.com" },
        to: { data: [{ id: "123", name: "Page" }] },
        attachments: {
          data: [
            {
              id: "a1",
              image_data: {
                url: "https://cdn.example.com/sticker.png",
                width: 120,
                height: 120,
                render_as_sticker: true,
              },
            },
            { id: "a2", name: "doc.pdf", file_url: "https://cdn.example.com/doc.pdf" },
          ],
        },
        shares: {
          data: [{ id: "s1", name: "A post", type: "post", url: "https://example.com/p" }],
        },
        story: { id: "st1", link: "https://cdn.example.com/story.jpg" },
        tags: { data: [{ name: "inbox" }, { name: "source:chat" }] },
        reactions: { data: [{ reaction: "❤️", users: [{ id: "456" }] }] },
      },
    ]);

    const detail = await native.getMessage({ account: page, messageId: "m_9", context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/m_9");
    assert.match(
      calls[0]?.url.searchParams.get("fields") ?? "",
      /attachments\{id,name,file_url,image_data,video_data\}/,
    );
    assert.equal(detail.sticker, "https://cdn.example.com/sticker.png");
    assert.equal(detail.attachments[1]?.fileUrl, "https://cdn.example.com/doc.pdf");
    assert.deepEqual(detail.from, { id: "456", name: "Ada" });
    assert.deepEqual(detail.shares, [
      { id: "s1", name: "A post", type: "post", url: "https://example.com/p" },
    ]);
    assert.deepEqual(detail.story, { id: "st1", link: "https://cdn.example.com/story.jpg" });
    assert.deepEqual(detail.tags, ["inbox", "source:chat"]);
    assert.deepEqual(detail.reactions, [{ reaction: "❤️", userIds: ["456"] }]);
  });
});

describe("facebook Messenger profile, handover, and labels", () => {
  it("reads, sets, and deletes Messenger profile properties [feature:facebook.messaging.profile]", async () => {
    const { calls, native } = fake([
      {
        data: [
          { greeting: [{ locale: "default", text: "Hello!" }], get_started: { payload: "GO" } },
        ],
      },
      { result: "success" },
      { result: "success" },
    ]);

    const profile = await native.getMessengerProfile({
      account: page,
      fields: ["greeting", "get_started"],
      context,
    });

    await native.setMessengerProfile({
      account: page,
      getStarted: { payload: "GET_STARTED" },
      greeting: [{ locale: "default", text: "Hi {{user_first_name}}" }],
      iceBreakers: [
        {
          call_to_actions: [{ question: "Where are you?", payload: "WHERE" }],
          locale: "default",
        },
      ],
      persistentMenu: [
        {
          locale: "default",
          composer_input_disabled: false,
          call_to_actions: [{ type: "postback", title: "Talk to us", payload: "TALK" }],
        },
      ],
      whitelistedDomains: ["https://shop.example.com"],
      context,
    });

    await native.deleteMessengerProfileFields({
      account: page,
      fields: ["persistent_menu", "ice_breakers"],
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/messenger_profile");
    assert.equal(calls[0]?.url.searchParams.get("fields"), "greeting,get_started");
    assert.deepEqual(profile, {
      greeting: [{ locale: "default", text: "Hello!" }],
      get_started: { payload: "GO" },
    });
    assert.deepEqual(calls[1]?.json, {
      get_started: { payload: "GET_STARTED" },
      greeting: [{ locale: "default", text: "Hi {{user_first_name}}" }],
      ice_breakers: [
        {
          call_to_actions: [{ question: "Where are you?", payload: "WHERE" }],
          locale: "default",
        },
      ],
      persistent_menu: [
        {
          locale: "default",
          composer_input_disabled: false,
          call_to_actions: [{ type: "postback", title: "Talk to us", payload: "TALK" }],
        },
      ],
      whitelisted_domains: ["https://shop.example.com/"],
    });
    assert.equal(calls[2]?.method, "DELETE");
    assert.deepEqual(calls[2]?.json, { fields: ["persistent_menu", "ice_breakers"] });
  });

  it("fails as ambiguous when the profile write is not confirmed [feature:facebook.messaging.profile]", async () => {
    const { native } = fake([{ result: "pending" }]);

    await assert.rejects(
      native.setMessengerProfile({ account: page, getStarted: { payload: "GO" }, context }),
      { code: "ambiguous_outcome" },
    );
  });

  it("passes, requests, and releases thread control and reads the owner [feature:facebook.messaging.handover]", async () => {
    const { calls, native } = fake([
      { success: true },
      { success: true },
      { success: true },
      { data: [{ thread_owner: { app_id: "263902037430900" } }] },
    ]);

    await native.passThreadControl({
      account: page,
      recipientId: "456",
      targetAppId: facebookPageInboxAppId,
      metadata: "needs a human",
      context,
    });

    await native.requestThreadControl({ account: page, recipientId: "456", context });
    await native.releaseThreadControl({ account: page, recipientId: "456", context });

    const owner = await native.getThreadOwner({ account: page, recipientId: "456", context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/pass_thread_control");
    assert.deepEqual(calls[0]?.json, {
      recipient: { id: "456" },
      target_app_id: "263902037430900",
      metadata: "needs a human",
    });
    assert.equal(calls[1]?.url.pathname, "/v27.0/123/request_thread_control");
    assert.equal(calls[2]?.url.pathname, "/v27.0/123/release_thread_control");
    assert.deepEqual(calls[2]?.json, { recipient: { id: "456" } });
    assert.equal(calls[3]?.url.pathname, "/v27.0/123/thread_owner");
    assert.equal(calls[3]?.url.searchParams.get("recipient"), "456");
    assert.deepEqual(owner, { appId: "263902037430900" });
  });

  it("creates, lists, assigns, removes, and deletes custom labels [feature:facebook.messaging.custom_labels]", async () => {
    const { calls, native } = fake([
      { id: 777 },
      { data: [{ id: "777", page_label_name: "VIP" }] },
      { data: [{ id: "777", page_label_name: "VIP" }] },
      { success: true },
      { success: true },
      { success: true },
    ]);

    const created = await native.createCustomLabel({ account: page, name: "VIP", context });
    const all = await native.listCustomLabels({ account: page, context });
    const mine = await native.listCustomLabels({ account: page, userId: "456", context });

    await native.setCustomLabel({
      account: page,
      labelId: "777",
      userId: "456",
      assigned: true,
      context,
    });

    await native.setCustomLabel({
      account: page,
      labelId: "777",
      userId: "456",
      assigned: false,
      context,
    });

    await native.deleteCustomLabel({ account: page, labelId: "777", context });

    assert.deepEqual(created, { id: "777" });
    assert.deepEqual(calls[0]?.json, { page_label_name: "VIP" });
    assert.equal(calls[0]?.url.pathname, "/v27.0/123/custom_labels");
    assert.deepEqual(all.items, [{ id: "777", name: "VIP" }]);
    assert.equal(calls[2]?.url.pathname, "/v27.0/456/custom_labels");
    assert.equal(mine.items.length, 1);
    assert.equal(calls[3]?.url.pathname, "/v27.0/777/label");
    assert.deepEqual(calls[3]?.json, { user: "456" });
    assert.equal(calls[4]?.method, "DELETE");
    assert.equal(calls[4]?.url.searchParams.get("user"), "456");
    assert.equal(calls[5]?.method, "DELETE");
    assert.equal(calls[5]?.url.pathname, "/v27.0/777");
  });
});

describe("facebook utility templates and calling", () => {
  it("creates, lists, and sends a utility template [feature:facebook.messaging.utility_templates]", async () => {
    const { calls, native } = fake([
      { id: "594", status: "PENDING", category: "UTILITY" },
      {
        data: [
          {
            id: "594",
            name: "order_update",
            language: "en",
            status: "APPROVED",
            category: "UTILITY",
            components: [{ type: "BODY", text: "Order {{1}} shipped" }],
          },
        ],
      },
      { recipient_id: "456", message_id: "m_t" },
    ]);

    const created = await native.createUtilityTemplate({
      account: page,
      name: "order_update",
      language: "en",
      components: [
        { type: "BODY", text: "Order {{1}} shipped", example: { body_text: [["566"]] } },
      ],
      context,
    });

    const listed = await native.listMessageTemplates({
      account: page,
      status: ["APPROVED"],
      context,
    });

    const sent = await native.sendUtilityTemplate({
      account: page,
      recipientId: "456",
      name: "order_update",
      language: "en",
      body: [{ text: "566701" }],
      context,
    });

    assert.deepEqual(created, { id: "594", status: "PENDING", category: "UTILITY" });
    assert.equal(calls[0]?.url.pathname, "/v27.0/123/message_templates");
    assert.deepEqual(calls[0]?.json, {
      name: "order_update",
      language: "en",
      category: "UTILITY",
      components: [
        { type: "BODY", text: "Order {{1}} shipped", example: { body_text: [["566"]] } },
      ],
    });
    assert.equal(calls[1]?.url.searchParams.get("status"), "APPROVED");
    assert.deepEqual(listed.items[0]?.["components"], [
      { type: "BODY", text: "Order {{1}} shipped" },
    ]);
    assert.equal(sent.messageId, "m_t");
    assert.deepEqual(calls[2]?.json, {
      recipient: { id: "456" },
      messaging_type: "UTILITY",
      message: {
        template: {
          name: "order_update",
          language: { code: "en" },
          components: [{ type: "body", parameters: [{ type: "text", text: "566701" }] }],
        },
      },
    });
  });

  it("reads and updates Messenger call settings [feature:facebook.messaging.calling]", async () => {
    const { calls, native } = fake([{ call_routing: { ring_target: "META" } }, { success: true }]);

    const settings = await native.getCallSettings({ account: page, context });

    await native.updateCallSettings({
      account: page,
      iconEnabled: true,
      ringTarget: "PARTNERS",
      callHours: {
        timezoneId: "America/Los_Angeles",
        weeklyOperatingHours: [{ dayOfWeek: "MONDAY", openTime: "0900", closeTime: "1700" }],
      },
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/messenger_call_settings");
    assert.equal(calls[0]?.url.searchParams.get("fields"), "call_hours,call_routing");
    assert.deepEqual(settings, { call_routing: { ring_target: "META" } });
    assert.deepEqual(calls[1]?.json, {
      icon_enabled: true,
      call_hours: {
        timezone_id: "America/Los_Angeles",
        weekly_operating_hours: [{ day_of_week: "MONDAY", open_time: "0900", close_time: "1700" }],
      },
      call_routing: { ring_target: "PARTNERS" },
    });
  });

  it("refuses call hours that close before they open [feature:facebook.messaging.calling]", async () => {
    const { calls, native } = fake([]);

    await assert.rejects(
      native.updateCallSettings({
        account: page,
        callHours: {
          timezoneId: "UTC",
          weeklyOperatingHours: [{ dayOfWeek: "MONDAY", openTime: "1700", closeTime: "0900" }],
        },
        context,
      }),
      /closeTime after openTime/,
    );

    assert.equal(calls.length, 0);
  });
});

describe("facebook Messenger webhook events", () => {
  const decode = (payload: JsonObject) =>
    decodePlatformWebhook({
      platform: "facebook",
      backend: "default",
      body: new TextEncoder().encode(JSON.stringify(payload)),
    });

  const person = { sender: { id: "9" }, recipient: { id: "123" }, timestamp: 1 };

  it("decodes standby deliveries and messaging_handovers events [feature:facebook.webhooks.standby_handover]", async () => {
    const event = await decode({
      object: "page",
      entry: [
        {
          id: "123",
          time: 1,
          standby: [{ ...person, message: { mid: "m_1", text: "hi" } }],
          messaging: [
            {
              ...person,
              pass_thread_control: { new_owner_app_id: "1", previous_owner_app_id: "2" },
            },
            { ...person, request_thread_control: { requested_owner_app_id: 3 } },
          ],
        },
      ],
    });

    assert.equal(event.type, "unknown");
    assert.equal(event.originalType, "messaging_handovers,standby.messages");
  });

  it("names message_edits, policy enforcement, account linking, and feedback [feature:facebook.webhooks.messaging_events]", async () => {
    const event = await decode({
      object: "page",
      entry: [
        {
          id: "123",
          time: 1,
          messaging: [
            { ...person, message_edit: { mid: "m_1", text: "fixed", num_edit: 1 } },
            { ...person, policy_enforcement: { action: "warning", reason: "spam" } },
            {
              ...person,
              account_linking: { status: "linked", authorization_code: "app-code" },
            },
            { ...person, response_feedback: { mid: "m_2", feedback: "Good response" } },
          ],
        },
      ],
    });

    assert.equal(
      event.originalType,
      "message_edits,messaging_policy_enforcement,messaging_account_linking,response_feedback",
    );
    assert.doesNotMatch(JSON.stringify(event.data), /app-code/);
  });
});
