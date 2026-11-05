import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { facebook } from "../src/platforms/facebook.js";
import { isJsonValue } from "../src/transport/json.js";
import { isJsonObject } from "../src/transport/validation.js";
import type { AdapterOperationContext, JsonObject, JsonValue } from "../src/core/types.js";

// Offline contract tests for Facebook Page management, engagement, and read features. Every
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

describe("facebook Page moderation and engagement", () => {
  it("lists blocked people and unblocks one [feature:facebook.moderation.unblock]", async () => {
    const { calls, native } = fake([
      { data: [{ id: "456", name: "Blocked Person" }] },
      { success: true },
    ]);

    const blocked = await native.listBlockedUsers({ account: page, context });

    await native.unblockUser({ account: page, userId: "456", context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/blocked");
    assert.deepEqual(blocked.items, [{ id: "456", name: "Blocked Person" }]);
    assert.equal(calls[1]?.method, "DELETE");
    assert.equal(calls[1]?.url.pathname, "/v27.0/123/blocked");
    assert.equal(calls[1]?.url.searchParams.get("user"), "456");
  });

  it("removes the app's Page webhook subscription [feature:facebook.webhooks.unsubscribe]", async () => {
    const { calls, native } = fake([{ success: true }]);

    await native.unsubscribeApp({ account: page, context });

    assert.equal(calls[0]?.method, "DELETE");
    assert.equal(calls[0]?.url.pathname, "/v27.0/123/subscribed_apps");
  });

  it("fails as ambiguous when the unsubscribe is not confirmed [feature:facebook.webhooks.unsubscribe]", async () => {
    const { native } = fake([{ success: false }]);

    await assert.rejects(native.unsubscribeApp({ account: page, context }), {
      code: "ambiguous_outcome",
    });
  });

  it("likes and unlikes a comment as the Page [feature:facebook.engagement.like]", async () => {
    const { calls, native } = fake([{ success: true }, { success: true }]);

    await native.setLike({ account: page, objectId: "123_1_9", liked: true, context });
    await native.setLike({ account: page, objectId: "123_1_9", liked: false, context });

    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.url.pathname, "/v27.0/123_1_9/likes");
    assert.equal(calls[1]?.method, "DELETE");
    assert.equal(calls[1]?.url.pathname, "/v27.0/123_1_9/likes");
  });
});

describe("facebook comment reads", () => {
  it("lists comments newest first with order=reverse_chronological [feature:facebook.comments.read.order]", async () => {
    const { calls, native } = fake([{ data: [] }]);

    await native.listComments({
      account: page,
      objectId: "123_1",
      order: "reverse_chronological",
      context,
    });

    assert.equal(calls[0]?.url.searchParams.get("order"), "reverse_chronological");
    assert.doesNotMatch(calls[0]?.url.searchParams.get("fields") ?? "", /private_reply/);
  });

  it("reads attachment, hidden state, private reply fields, and message tags [feature:facebook.comments.read.fields]", async () => {
    const { calls, native } = fake([
      {
        data: [
          {
            id: "123_1_9",
            message: "Thanks Page",
            created_time: "2026-11-01T00:00:00+0000",
            is_hidden: false,
            can_comment: true,
            can_reply_privately: true,
            private_reply_conversation: { id: "t_55" },
            attachment: {
              type: "photo",
              url: "https://example.com/photo",
              media: { image: { src: "https://cdn.example.com/i.jpg" } },
            },
            message_tags: [{ id: "123", name: "Page", type: "page", offset: 7, length: 4 }],
          },
        ],
      },
    ]);

    const comments = await native.listComments({
      account: page,
      objectId: "123_1",
      privateReplyFields: true,
      context,
    });

    const fields = calls[0]?.url.searchParams.get("fields") ?? "";
    const [comment] = comments.items;

    assert.match(fields, /can_reply_privately/);
    assert.match(fields, /private_reply_conversation/);
    assert.match(fields, /attachment/);
    assert.equal(comment?.["can_reply_privately"], true);
    assert.equal(comment?.["is_hidden"], false);
    assert.equal(comment?.["private_reply_conversation_id"], "t_55");
    assert.deepEqual(comment?.["attachment"], {
      type: "photo",
      url: "https://example.com/photo",
      media: { image: { src: "https://cdn.example.com/i.jpg" } },
    });
    assert.deepEqual(comment?.["message_tags"], [
      { id: "123", name: "Page", type: "page", offset: 7, length: 4 },
    ]);
  });

  it("lists the reshares of a post [feature:facebook.read.sharedposts]", async () => {
    const { calls, native } = fake([
      {
        data: [{ id: "9_1", created_time: "2026-11-01T00:00:00+0000", message: "Look" }],
        paging: { cursors: { after: "A" }, next: "https://graph.facebook.com/next" },
      },
    ]);

    const shares = await native.listSharedPosts({ account: page, postId: "123_1", context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123_1/sharedposts");
    assert.equal(shares.items[0]?.["id"], "9_1");
    assert.equal(shares.nextCursor, "A");
  });
});

describe("facebook Page administration", () => {
  it("reads, assigns, and removes business users' Page tasks [feature:facebook.account.assigned_users]", async () => {
    const { calls, native } = fake([
      {
        data: [
          { id: "77", name: "Ops", tasks: ["MANAGE", "MODERATE"], permitted_tasks: ["MANAGE"] },
        ],
      },
      { success: true },
      { success: true },
    ]);

    const users = await native.listAssignedUsers({ account: page, businessId: "500", context });

    await native.assignUser({
      account: page,
      userId: "77",
      tasks: ["CREATE_CONTENT", "MODERATE"],
      context,
    });

    await native.unassignUser({ account: page, userId: "77", context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/assigned_users");
    assert.equal(calls[0]?.url.searchParams.get("business"), "500");
    assert.deepEqual(users.items, [
      { id: "77", name: "Ops", tasks: ["MANAGE", "MODERATE"], permitted_tasks: ["MANAGE"] },
    ]);
    assert.deepEqual(calls[1]?.json, { user: "77", tasks: ["CREATE_CONTENT", "MODERATE"] });
    assert.equal(calls[2]?.method, "DELETE");
    assert.equal(calls[2]?.url.searchParams.get("user"), "77");
  });

  it("lists, adds, and removes location Pages [feature:facebook.account.locations]", async () => {
    const { calls, native } = fake([
      { data: [{ id: "321", name: "Store Lisbon", store_number: 7 }] },
      { success: true },
      { success: true },
      { success: true },
    ]);

    const locations = await native.listLocations({ account: page, context });

    await native.addLocation({ account: page, storeNumber: "7", locationPageId: "321", context });

    await native.addLocation({
      account: page,
      storeNumber: "8",
      newLocation: {
        location: {
          street: "1 Main St",
          city: "Lisbon",
          country: "Portugal",
          latitude: 38.72,
          longitude: -9.14,
        },
        placeTopics: [139],
        phone: "+351 000 000 000",
      },
      context,
    });

    await native.removeLocation({
      account: page,
      storeNumber: "7",
      locationPageId: "321",
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/locations");
    assert.equal(locations.items[0]?.["store_number"], 7);
    assert.deepEqual(calls[1]?.json, {
      main_page_id: "123",
      store_number: "7",
      location_page_id: "321",
    });
    assert.deepEqual(calls[2]?.json, {
      main_page_id: "123",
      store_number: "8",
      location: {
        street: "1 Main St",
        city: "Lisbon",
        country: "Portugal",
        latitude: "38.72",
        longitude: "-9.14",
      },
      place_topics: [139],
      phone: "+351 000 000 000",
    });
    assert.equal(calls[3]?.method, "DELETE");
    assert.equal(calls[3]?.url.searchParams.get("location_page_id"), "321");
    assert.equal(calls[3]?.url.searchParams.get("main_page_id"), "123");
  });

  it("lists video playlists [feature:facebook.read.video_lists]", async () => {
    const { calls, native } = fake([{ data: [{ id: "vl1", title: "Season 1" }] }]);

    const lists = await native.listVideoLists({ account: page, context });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/video_lists");
    assert.deepEqual(lists.items, [{ id: "vl1", title: "Season 1" }]);
  });

  it("sets the profile picture and the cover photo with offsets [feature:facebook.account.picture_cover]", async () => {
    const { calls, native } = fake([{ success: true }, { success: true }, { success: true }]);

    await native.setProfilePicture({
      account: page,
      pictureUrl: "https://cdn.example.com/logo.png",
      context,
    });

    await native.setProfilePicture({ account: page, photoId: "4040", context });

    await native.setCoverPhoto({
      account: page,
      photoId: "5050",
      offsetY: 40,
      noFeedStory: true,
      context,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/123/picture");
    assert.deepEqual(calls[0]?.json, { picture: "https://cdn.example.com/logo.png" });
    assert.deepEqual(calls[1]?.json, { photo: "4040" });
    assert.equal(calls[2]?.url.pathname, "/v27.0/123");
    assert.deepEqual(calls[2]?.json, { cover: "5050", offset_y: 40, no_feed_story: true });
  });

  it("refuses a cover offset outside 0 to 100 [feature:facebook.account.picture_cover]", async () => {
    const { calls, native } = fake([]);

    await assert.rejects(
      native.setCoverPhoto({ account: page, photoId: "5050", offsetX: 140, context }),
      /0 through 100/,
    );

    assert.equal(calls.length, 0);
  });
});
