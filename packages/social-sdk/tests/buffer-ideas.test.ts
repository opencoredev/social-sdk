import { it } from "node:test";
import assert from "node:assert/strict";
import { buffer } from "../src/cloud/buffer.js";
import { SocialError } from "../src/core/errors.js";
import type { AdapterOperationContext, JsonObject, JsonValue } from "../src/core/types.js";
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
function fakeBuffer(answer: (operation: Operation) => JsonValue) {
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
    adapter: buffer({ apiKey: "fixture-key", organizationId: "org_example", fetch }),
  };
}

it("Buffer creates an idea with media, tags, services, templateId, cta and group placement [feature:buffer.publish.ideas.content_options]", async () => {
  const { adapter, operations } = fakeBuffer(() => ({ createIdea: { idea: { id: "idea_1" } } }));

  const created = await adapter.native.createIdea(
    {
      title: "Spring launch",
      text: "Teaser thread for the launch",
      media: [
        {
          url: "https://images.example.test/photo.jpg",
          type: "image",
          alt: "A desk with a laptop",
          thumbnailUrl: "https://images.example.test/photo-small.jpg",
          size: 120_000,
          source: { name: "Unsplash", author: "Ana", authorUrl: "https://unsplash.com/@ana" },
        },
      ],
      tags: [{ id: "tag_launch", name: "Launch", color: "#F523F1" }],
      services: ["instagram", "twitter"],
      aiAssisted: true,
      templateId: "template_7",
      cta: "ideas-board",
      groupId: "group_1",
      placeAfterId: "idea_0",
    },
    context,
  );

  assert.deepEqual(created, { id: "idea_1" });
  assert.deepEqual(operations[0]?.variables["input"], {
    organizationId: "org_example",
    content: {
      title: "Spring launch",
      text: "Teaser thread for the launch",
      media: [
        {
          url: "https://images.example.test/photo.jpg",
          type: "image",
          alt: "A desk with a laptop",
          thumbnailUrl: "https://images.example.test/photo-small.jpg",
          size: 120_000,
          source: { name: "Unsplash", author: "Ana", authorUrl: "https://unsplash.com/@ana" },
        },
      ],
      tags: [{ id: "tag_launch", name: "Launch", color: "#F523F1" }],
      services: ["instagram", "twitter"],
      aiAssisted: true,
    },
    templateId: "template_7",
    cta: "ideas-board",
    group: { groupId: "group_1", placeAfterId: "idea_0" },
  });

  for (const bad of [
    { title: "x", services: ["x"] },
    { media: [{ url: "https://cdn.example.test/v.mp4", type: "image" as const, size: -1 }] },
    { title: "x", tags: [{ id: "tag_1", name: "Bad", color: "pink" }] },
  ])
    await assert.rejects(
      adapter.native.createIdea(bad, context),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );

  assert.equal(operations.length, 1);
});

it("Buffer lists ideaGroups and filters ideas by group and tags [feature:buffer.read.idea_groups]", async () => {
  const { adapter, operations } = fakeBuffer((operation) =>
    operation.query.includes("ideaGroups")
      ? {
          ideaGroups: [
            { id: "group_1", name: "Next week", isLocked: false },
            { id: "group_2", name: "Archive", isLocked: true },
          ],
        }
      : {
          ideas: {
            edges: [
              {
                cursor: "c1",
                node: {
                  id: "idea_1",
                  groupId: "group_1",
                  position: 1.5,
                  createdAt: 1_793_000_000,
                  updatedAt: 1_793_000_600,
                  content: {
                    title: "Spring launch",
                    text: null,
                    date: "2026-11-20T09:00:00.000Z",
                    aiAssisted: false,
                    services: ["instagram"],
                    tags: [{ id: "tag_launch", name: "Launch", color: "#F523F1" }],
                    media: [{ url: "https://cdn.buffer.com/a.jpg", type: "image", alt: null }],
                  },
                },
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
        },
  );

  assert.deepEqual(await adapter.native.listIdeaGroups({}, context), [
    { id: "group_1", name: "Next week", isLocked: false },
    { id: "group_2", name: "Archive", isLocked: true },
  ]);
  assert.deepEqual(operations[0]?.variables, { input: { organizationId: "org_example" } });

  const page = await adapter.native.listIdeas(
    { groupIds: ["group_1"], tags: { in: ["tag_launch"] }, limit: 5 },
    context,
  );

  assert.deepEqual(operations[1]?.variables, {
    first: 5,
    input: {
      organizationId: "org_example",
      groupFilter: { groups: ["group_1"] },
      tagsFilter: { in: ["tag_launch"], isEmpty: false },
    },
  });
  assert.deepEqual(page, {
    items: [
      {
        id: "idea_1",
        aiAssisted: false,
        services: ["instagram"],
        tags: [{ id: "tag_launch", name: "Launch", color: "#F523F1" }],
        media: [{ url: "https://cdn.buffer.com/a.jpg", type: "image" }],
        createdAt: "2026-10-26T07:33:20.000Z",
        updatedAt: "2026-10-26T07:43:20.000Z",
        groupId: "group_1",
        position: 1.5,
        title: "Spring launch",
        date: "2026-11-20T09:00:00.000Z",
      },
    ],
    nextCursor: "c1",
  });

  await adapter.native.listIdeas({ membership: "ungrouped" }, context);

  assert.deepEqual(object(operations[2]?.variables["input"])["groupFilter"], {
    membership: "ungrouped",
  });

  await assert.rejects(
    adapter.native.listIdeas({ groupIds: ["group_1"], membership: "grouped" }, context),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});
