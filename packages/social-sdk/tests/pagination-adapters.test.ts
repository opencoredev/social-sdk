import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createSocial } from "../src/core/client.js";
import { connectedAccountRef } from "../src/core/types.js";
import { linkedin } from "../src/platforms/linkedin.js";
import { youtube } from "../src/platforms/youtube.js";
import { zernio } from "../src/cloud/zernio.js";

const post = {
  kind: "platform-post" as const,
  version: 1 as const,
  backend: "default",
  platform: "youtube" as const,
  accountId: "channel",
  postId: "video",
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("YouTube comment page tokens are exposed as scoped cursors", async () => {
  const urls: string[] = [];

  const adapter = youtube({
    auth: { accessToken: "token", channelId: "channel" },
    fetch: async (input) => {
      urls.push(String(input));

      if (String(input).includes("/videos"))
        return json({ items: [{ id: "video", snippet: { channelId: "channel" } }] });

      return json({
        items: [
          {
            id: "comment",
            snippet: { topLevelComment: { id: "comment", snippet: { textDisplay: "hello" } } },
          },
        ],
        nextPageToken: "provider-page-2",
      });
    },
  });

  const social = createSocial({ backend: adapter });

  const first = await social.comments.list(post, {
    limit: 1,
    authorization: { tenantId: "tenant" },
  });

  assert.match(first.nextCursor ?? "", /^social-v1\./);
  await social.comments.list(post, {
    limit: 1,
    cursor: first.nextCursor,
    authorization: { tenantId: "tenant" },
  });
  assert.ok(
    urls.some((url) => url.includes("pageToken=provider-page-2") && url.includes("maxResults=1")),
  );
  await assert.rejects(
    social.comments.list(
      { ...post, postId: "other" },
      { limit: 1, cursor: first.nextCursor, authorization: { tenantId: "tenant" } },
    ),
    { code: "invalid_input" },
  );
});

test("LinkedIn comment offsets page only when upstream paging reports a total", async () => {
  const urls: string[] = [];

  const adapter = linkedin({
    auth: { accessToken: "token", author: "urn:li:person:member" },
    apiVersion: "202609",
    fetch: async (input) => {
      const url = String(input);
      urls.push(url);

      if (url.includes("/rest/posts/"))
        return json({ id: "urn:li:share:1", author: "urn:li:person:member" });

      if (url.includes("start=0"))
        return json({ elements: [{ id: "1", message: { text: "one" } }], paging: { total: 2 } });

      return json({ elements: [{ id: "2", message: { text: "two" } }], paging: { total: 2 } });
    },
  });

  const social = createSocial({ backend: adapter });
  const ref = { ...post, platform: "linkedin" as const, accountId: "urn:li:person:member" };
  const first = await social.comments.list(ref, { limit: 1 });
  assert.equal(first.nextCursor?.startsWith("social-v1."), true);
  await social.comments.list(ref, { limit: 1, cursor: first.nextCursor });
  assert.ok(urls.some((url) => url.includes("start=1&count=1")));
});

test("Zernio comment and message cursors pass through as opaque provider values", async () => {
  const urls: string[] = [];

  const adapter = zernio({
    apiKey: "key",
    fetch: async (input) => {
      const url = String(input);
      urls.push(url);

      if (url.includes("/comments/"))
        return json({
          comments: [{ id: "comment", message: "hello" }],
          pagination: { cursor: "comments-next" },
        });

      if (url.includes("/conversations?"))
        return json({
          data: [{ id: "conversation", platform: "x", accountId: "account" }],
          pagination: { nextCursor: "conversations-next" },
        });

      return json({
        messages: [{ id: "message", message: "hello" }],
        pagination: { nextCursor: "messages-next" },
      });
    },
  });

  const social = createSocial({ backend: adapter });
  const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "account" });

  const conversation = {
    kind: "conversation" as const,
    version: 1 as const,
    backend: "default",
    platform: "x" as const,
    accountId: "account",
    conversationId: "conversation",
  };

  const firstConversation = await social.messages.listConversations(account, { limit: 1 });
  await social.messages.listConversations(account, {
    limit: 1,
    cursor: firstConversation.nextCursor,
  });
  const firstMessages = await social.messages.listMessages(conversation, { limit: 1 });
  await social.messages.listMessages(conversation, { limit: 1, cursor: firstMessages.nextCursor });
  assert.ok(
    urls.some((url) => url.includes("cursor=conversations-next") && url.includes("limit=1")),
  );
  assert.ok(urls.some((url) => url.includes("cursor=messages-next") && url.includes("limit=1")));
});
