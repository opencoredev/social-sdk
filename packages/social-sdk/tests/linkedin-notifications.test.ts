import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { linkedin } from "../src/platforms/linkedin.js";
import { decodePlatformWebhook } from "../src/server/webhooks.js";
import type { JsonObject } from "../src/core/types.js";
import { definedFields } from "../src/core/fields.js";
import { object } from "../src/transport/validation.js";

const nativeContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

const organizationUrn = "urn:li:organization:12345";

const organization = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: organizationUrn,
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body?: JsonObject;
}

function setup(respond: (call: Call) => Response) {
  const calls: Call[] = [];

  const native = linkedin({
    auth: { accessToken: "secret", author: organizationUrn },
    apiVersion: "202610",
    fetch: async (input, init) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        ...definedFields({ body: init?.body ? object(JSON.parse(String(init.body))) : undefined }),
      };

      calls.push(call);

      return respond(call);
    },
  }).native!;

  return { calls, native };
}

it("decodes each organization social action to its normalized event type", async () => {
  const expected = [
    ["LIKE", "reaction.received"],
    ["SHARE", "post.reshared"],
    ["SHARE_MENTION", "mention.received"],
    ["COMMENT", "comment.received"],
    ["COMMENT_EDIT", "comment.updated"],
    ["COMMENT_DELETE", "comment.removed"],
    ["ADMIN_COMMENT", "unknown"],
    ["constructor", "unknown"],
  ] as const;

  for (const [action, type] of expected) {
    const event = await decodePlatformWebhook({
      platform: "linkedin",
      backend: "direct",
      body: new TextEncoder().encode(
        JSON.stringify({
          type: "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS",
          notifications: [
            {
              notificationId: 4406004,
              organizationalEntity: organizationUrn,
              action,
              sourcePost: "urn:li:activity:29292929292992929292",
              lastModifiedAt: 1535741251282,
            },
          ],
        }),
      ),
    });

    assert.equal(event.type, type, action);
    assert.equal(event.originalType, action);
  }
});

it("filters pulled notifications by sourcePost and timeRange", async () => {
  const { calls, native } = setup(() =>
    Response.json({
      elements: [
        {
          notificationId: 4406044,
          organizationalEntity: organizationUrn,
          action: "SHARE_MENTION",
          sourcePost: "urn:li:activity:92828282828282828828",
          generatedActivity: "urn:li:share:6441333333905633322",
          lastModifiedAt: 1535741320050,
        },
      ],
      paging: { count: 10, start: 0, links: [] },
    }),
  );

  const page = await native.listOrganizationNotifications({
    account: organization,
    actions: ["SHARE_MENTION"],
    sourcePost: "urn:li:activity:92828282828282828828",
    timeRange: { start: 1535000000000, end: 1536000000000 },
    context: nativeContext,
  });

  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/organizationalEntityNotifications?q=criteria&actions=List(SHARE_MENTION)&organizationalEntity=urn%3Ali%3Aorganization%3A12345&timeRange=(start:1535000000000,end:1536000000000)&sourcePost=urn%3Ali%3Aactivity%3A92828282828282828828&start=0&count=25",
  );
  assert.equal(page.items[0]?.["action"], "SHARE_MENTION");

  for (const filters of [
    { actions: ["COMMENT" as const, "LIKE" as const], sourcePost: "urn:li:activity:1" },
    { timeRange: { start: 10, end: 5 } },
    { timeRange: {} },
    { actions: [] },
  ])
    await assert.rejects(
      native.listOrganizationNotifications({
        account: organization,
        ...filters,
        context: nativeContext,
      }),
      /documented notification actions/,
    );
  assert.equal(calls.length, 1);
});

const key =
  "(developerApplication:urn%3Ali%3AdeveloperApplication%3A777,user:urn%3Ali%3Aperson%3AabCdef,entity:urn%3Ali%3Aorganization%3A12345,eventType:ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS)";

it("creates, lists and removes organization notification subscriptions with /rest/eventSubscriptions", async () => {
  const { calls, native } = setup((call) =>
    call.method === "GET"
      ? Response.json({
          elements: [
            {
              entity: organizationUrn,
              eventType: "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS",
              user: "urn:li:person:abCdef",
              expiresAt: "1536130694583",
              webhook: "https://www.example.com/callback",
            },
            {
              entity: "urn:li:organization:45678",
              eventType: "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS",
              member: "urn:li:person:abCdef",
              expiresAt: "1537176459876",
              webhook: "https://www.example.com/callback",
            },
          ],
        })
      : new Response(null, { status: call.method === "PUT" ? 201 : 200 }),
  );

  await native.subscribeOrganizationNotifications({
    account: organization,
    developerApplication: "urn:li:developerApplication:777",
    member: "urn:li:person:abCdef",
    webhook: "https://www.example.com/callback",
    context: nativeContext,
  });

  assert.equal(calls[0]?.method, "PUT");
  assert.equal(calls[0]?.url, `https://api.linkedin.com/rest/eventSubscriptions/${key}`);
  assert.deepEqual(calls[0]?.body, { webhook: "https://www.example.com/callback" });

  const subscriptions = await native.listOrganizationNotificationSubscriptions({
    account: organization,
    context: nativeContext,
  });

  assert.equal(
    calls[1]?.url,
    "https://api.linkedin.com/rest/eventSubscriptions?q=subscriberAndEventType&eventType=ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS",
  );
  assert.deepEqual(subscriptions, [
    {
      entity: organizationUrn,
      eventType: "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS",
      user: "urn:li:person:abCdef",
      webhook: "https://www.example.com/callback",
      expiresAt: 1536130694583,
    },
  ]);

  await native.unsubscribeOrganizationNotifications({
    account: organization,
    developerApplication: "urn:li:developerApplication:777",
    member: "urn:li:person:abCdef",
    context: nativeContext,
  });

  assert.equal(calls[2]?.method, "DELETE");
  assert.equal(calls[2]?.url, `https://api.linkedin.com/rest/eventSubscriptions/${key}`);

  await assert.rejects(
    native.subscribeOrganizationNotifications({
      account: organization,
      developerApplication: "urn:li:developerApplication:777",
      member: "urn:li:person:abCdef",
      webhook: "http://www.example.com/callback",
      context: nativeContext,
    }),
    /HTTPS/,
  );
  assert.equal(calls.length, 3);
});
