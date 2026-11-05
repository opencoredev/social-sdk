import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { buffer } from "../src/cloud/buffer.js";
import { SocialError } from "../src/core/errors.js";
import type { AdapterOperationContext } from "../src/core/types.js";
import { isJsonValue } from "../src/transport/json.js";
import { object, string } from "../src/transport/validation.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "buffer-post-type-filters",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const instagram = connectedAccountRef({
  backend: "default",
  platform: "instagram",
  accountId: "64e8f6b5c9a1d2e3f4a5b6c7",
});

/** A Buffer adapter whose fake GraphQL answers channel lookups and empty post pages. */
function fixture() {
  const queries: string[] = [];

  const adapter = buffer({
    apiKey: "fixture-key",
    organizationId: "org_fixture",
    fetch: async (_input, init) => {
      const parsed: unknown = JSON.parse(String(init?.body));

      assert.ok(isJsonValue(parsed));

      const query = string(object(parsed)["query"]);

      queries.push(query);

      if (query.includes("query Channels"))
        return Response.json({
          data: {
            channels: [
              {
                id: instagram.accountId,
                service: "instagram",
                organizationId: "org_fixture",
                name: "Fixture channel",
              },
            ],
          },
        });

      return Response.json({
        data: { posts: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    },
  });

  return { adapter, queries };
}

// Buffer reference: PostsFiltersInput.postTypes rejects carousel and thread.
for (const postType of ["carousel", "thread"])
  it(`Buffer rejects the ${postType} filter because it is not a stored post type`, async () => {
    const { adapter, queries } = fixture();

    await assert.rejects(
      adapter.native.listPosts({ accounts: [instagram], postTypes: [postType] }, context),
      (error) => error instanceof SocialError && error.code === "invalid_input",
      `Buffer rejects the ${postType} filter; it must not pass local validation.`,
    );
    assert.equal(queries.length, 0);
  });

it("Buffer still accepts stored post types and the post fallback bucket", async () => {
  const { adapter } = fixture();

  const page = await adapter.native.listPosts(
    { accounts: [instagram], postTypes: ["post", "reel", "story"] },
    context,
  );

  assert.deepEqual(page.items, []);
});
