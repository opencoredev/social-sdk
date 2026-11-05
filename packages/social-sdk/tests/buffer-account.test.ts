import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { buffer } from "../src/cloud/buffer.js";
import { SocialError } from "../src/core/errors.js";
import type { AdapterOperationContext, JsonObject, JsonValue } from "../src/core/types.js";
import { definedFields } from "../src/core/fields.js";
import { isJsonValue } from "../src/transport/json.js";
import { object, string } from "../src/transport/validation.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

interface Operation {
  readonly query: string;
  readonly variables: JsonObject;
}

/** A fake Buffer GraphQL API that answers every operation with `answer`. */
function fakeBuffer(answer: (operation: Operation) => JsonValue, organizationId?: string) {
  const operations: Operation[] = [];

  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const parsed: unknown = JSON.parse(String(init?.body));

    assert.ok(isJsonValue(parsed));

    const body = object(parsed);
    const operation = { query: string(body["query"]), variables: object(body["variables"] ?? {}) };

    operations.push(operation);

    return Response.json({ data: answer(operation) });
  };

  return {
    operations,
    adapter: buffer({ apiKey: "fixture-key", fetch, ...definedFields({ organizationId }) }),
  };
}

const channel = {
  id: "channel_1",
  name: "acme",
  displayName: "Acme",
  service: "instagram",
  serviceId: "1784",
  organizationId: "org_example",
  type: "business",
  timezone: "America/New_York",
  isLocked: false,
  isDisconnected: false,
  isQueuePaused: true,
  externalLink: "https://instagram.com/acme",
  allowedActions: ["viewChannel", "scheduleUpdates"],
  products: ["publish", "analyze"],
  scopes: ["instagram_basic"],
  linkShortening: { isEnabled: true },
  postingGoal: {
    goal: 5,
    sentCount: 2,
    scheduledCount: 1,
    status: "AtRisk",
    periodStart: "2026-11-02T00:00:00.000Z",
    periodEnd: "2026-11-08T23:59:59.000Z",
  },
};

it("Buffer filters channels by isLocked and product [feature:buffer.account.channels_filter]", async () => {
  const { adapter, operations } = fakeBuffer(() => ({ channels: [channel] }), "org_example");

  const channels = await adapter.native.listChannels(
    { isLocked: false, product: "publish" },
    context,
  );

  assert.deepEqual(operations[0]?.variables, {
    input: { organizationId: "org_example", filter: { isLocked: false, product: "publish" } },
  });
  assert.equal(channels.length, 1);

  await adapter.native.listChannels({}, context);

  assert.deepEqual(operations[1]?.variables, { input: { organizationId: "org_example" } });
});

it("Buffer reads channel timezone, postingGoal, linkShortening and allowed actions [feature:buffer.account.channel_settings]", async () => {
  const { adapter } = fakeBuffer(() => ({ channels: [channel] }), "org_example");
  const [read] = await adapter.native.listChannels({}, context);

  assert.deepEqual(read, {
    id: "channel_1",
    service: "instagram",
    serviceId: "1784",
    name: "acme",
    organizationId: "org_example",
    type: "business",
    timezone: "America/New_York",
    isLocked: false,
    isDisconnected: false,
    isQueuePaused: true,
    linkShortening: { isEnabled: true },
    allowedActions: ["viewChannel", "scheduleUpdates"],
    products: ["publish", "analyze"],
    scopes: ["instagram_basic"],
    platform: "instagram",
    displayName: "Acme",
    url: "https://instagram.com/acme",
    postingGoal: {
      goal: 5,
      sentCount: 2,
      scheduledCount: 1,
      status: "AtRisk",
      periodStart: "2026-11-02T00:00:00.000Z",
      periodEnd: "2026-11-08T23:59:59.000Z",
    },
  });
});

it("Buffer reads organization limits like scheduledPosts and the member count [feature:buffer.account.organization_limits]", async () => {
  const { adapter, operations } = fakeBuffer(() => ({
    account: {
      organizations: [
        {
          id: "org_example",
          name: "Acme",
          channelCount: 3,
          members: { totalCount: 4 },
          limits: {
            channels: 10,
            members: 5,
            scheduledPosts: 2000,
            scheduledStoriesPerChannel: 100,
            scheduledThreadsPerChannel: 50,
            ideas: 500,
            ideaGroups: 20,
            tags: 100,
            postTemplates: 50,
            savedReplies: 20,
            generateContent: 1000,
          },
        },
      ],
    },
  }));

  const [organization] = await adapter.native.listOrganizations(context);

  assert.match(string(operations[0]?.query), /members \{\s+totalCount/);
  assert.deepEqual(organization, {
    id: "org_example",
    name: "Acme",
    channelCount: 3,
    memberCount: 4,
    limits: {
      channels: 10,
      members: 5,
      scheduledPosts: 2000,
      scheduledStoriesPerChannel: 100,
      scheduledThreadsPerChannel: 50,
      ideas: 500,
      ideaGroups: 20,
      tags: 100,
      postTemplates: 50,
      savedReplies: 20,
      generateContent: 1000,
    },
  });
});

it("Buffer reads the account timezone and defaultScheduleOption [feature:buffer.account.preferences]", async () => {
  const { adapter, operations } = fakeBuffer(() => ({
    account: {
      id: "acct_1",
      name: "Sam",
      timezone: "Europe/Berlin",
      preferences: { timeFormat: "24", startOfWeek: "monday", defaultScheduleOption: "Queue" },
    },
  }));

  assert.deepEqual(await adapter.native.getAccount(context), {
    id: "acct_1",
    name: "Sam",
    timezone: "Europe/Berlin",
    preferences: { defaultScheduleOption: "Queue", timeFormat: "24", startOfWeek: "monday" },
  });
  assert.doesNotMatch(string(operations[0]?.query), /\bemail\b/);
});

it("Buffer reads configuration authorizationStatus and content rules [feature:buffer.account.configuration]", async () => {
  const content = [
    {
      configurationContentTypes: ["post"],
      supportedProperties: ["text", "image", "video"],
      rules: [
        { __typename: "LengthRule", property: "text", maxLength: 280 },
        { __typename: "CountRule", property: "image", min: null, max: 4 },
        { __typename: "ExclusiveRule", property: "video", conflictsWith: ["image"] },
      ],
    },
  ];

  const { adapter, operations } = fakeBuffer(
    () => ({
      configuration: {
        channels: [
          {
            channelId: "channel_1",
            service: "twitter",
            channelType: "profile",
            authorizationStatus: [
              { feature: "posting", status: "ok", reason: null },
              { feature: "insights", status: "needsUpgrade", reason: "Plan has no analytics" },
            ],
            content,
          },
        ],
        services: [{ service: "twitter", channelType: "profile", content }],
      },
    }),
    "org_example",
  );

  const configuration = await adapter.native.getConfiguration({}, context);

  assert.deepEqual(operations[0]?.variables, { input: { organizationId: "org_example" } });
  assert.deepEqual(configuration.channels[0]?.authorizationStatus, [
    { feature: "posting", status: "ok" },
    { feature: "insights", status: "needsUpgrade", reason: "Plan has no analytics" },
  ]);
  assert.deepEqual(configuration.services[0]?.content, [
    {
      contentTypes: ["post"],
      supportedProperties: ["text", "image", "video"],
      rules: [
        { kind: "LengthRule", property: "text", maxLength: 280 },
        { kind: "CountRule", property: "image", max: 4 },
        { kind: "ExclusiveRule", property: "video", conflictsWith: ["image"] },
      ],
    },
  ]);
});

it("Buffer lists selectableTeamMembers by organization or channel [feature:buffer.account.team_members]", async () => {
  const { adapter, operations } = fakeBuffer(
    (operation) =>
      operation.query.includes("query Channels")
        ? {
            channels: [
              {
                id: "channel_1",
                name: "acme",
                displayName: "Acme",
                service: "twitter",
                organizationId: "org_example",
              },
            ],
          }
        : {
            selectableTeamMembers: {
              edges: [
                {
                  cursor: "m1",
                  node: {
                    id: "acct_2",
                    name: "Rae",
                    urn: "urn:buffer:account:acct_2",
                    isLocked: false,
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: "m1" },
            },
          },
    "org_example",
  );

  const byOrganization = await adapter.native.listTeamMembers({ search: "ra", limit: 10 }, context);

  assert.deepEqual(byOrganization, {
    items: [{ id: "acct_2", urn: "urn:buffer:account:acct_2", isLocked: false, name: "Rae" }],
  });
  assert.deepEqual(operations[0]?.variables, {
    first: 10,
    input: { scope: { organizationId: "org_example" }, search: "ra" },
  });
  assert.doesNotMatch(string(operations[0]?.query), /\bemail\b/);

  const account = connectedAccountRef({
    backend: "default",
    platform: "x",
    accountId: "channel_1",
  });

  await adapter.native.listTeamMembers({ account }, context);

  assert.deepEqual(object(operations.at(-1)?.variables["input"])["scope"], {
    channelId: "channel_1",
  });

  await assert.rejects(
    adapter.native.listTeamMembers({ account, organizationId: "org_example" }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});
