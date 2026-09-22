/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-readable-spacing -- compact mocked transport fixtures. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { connectedAccountRef, createSocial, profileRef } from "../src/index.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "u1" });

it("normalizes X profiles and paginated graph reads through the client facade", async () => {
  const urls: URL[] = [];
  const social = createSocial({
    backend: x({
      auth: { userId: "u1", accessToken: "token" },
      fetch: async (input) => {
        const url = new URL(String(input));
        urls.push(url);
        if (url.pathname === "/2/users/by/username/alice") {
          assert.equal(
            url.searchParams.get("user.fields"),
            "id,name,username,description,created_at,public_metrics,profile_image_url,verified",
          );
          return Response.json({
            data: { id: "u2", name: "Alice", username: "alice", description: "Hello" },
          });
        }
        if (url.pathname === "/2/users/u1/following")
          return Response.json({
            data: [{ id: "u2", name: "Alice", username: "alice" }],
            meta: { next_token: "next" },
          });
        return Response.json({ meta: {} });
      },
    }),
  });

  const profile = await social.graph.getProfile(account, { handle: "alice" });
  assert.deepEqual(
    {
      id: profile.ref.profileId,
      name: profile.displayName,
      handle: profile.handle,
      bio: profile.bio,
    },
    { id: "u2", name: "Alice", handle: "alice", bio: "Hello" },
  );

  const page = await social.graph.listRelationships(account, {
    kind: "following",
    limit: 25,
  });
  assert.equal(page.items[0]?.profile.profileId, "u2");
  assert.equal(page.items[0]?.relationship, "following");
  assert.ok(page.nextCursor?.startsWith("social-v1."));
  assert.equal(urls[1]?.searchParams.get("max_results"), "25");

  await social.graph.listRelationships(account, {
    kind: "following",
    cursor: page.nextCursor,
    limit: 25,
  });
  assert.equal(urls[2]?.searchParams.get("pagination_token"), "next");

  const empty = await social.graph.listRelationships(account, { kind: "muted" });
  assert.deepEqual(empty, { items: [] });
});

it("normalizes X follow, mute, block, and unblock writes", async () => {
  const requests: { path: string; method: string }[] = [];
  const social = createSocial({
    backend: x({
      auth: { userId: "u1", accessToken: "token" },
      fetch: async (input, init) => {
        requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET" });
        return Response.json({ data: {} });
      },
    }),
  });
  const target = profileRef({ ...account, profileId: "u2" });

  assert.equal((await social.graph.follow(target)).relationship, "following");
  await social.graph.unfollow(target);
  assert.equal((await social.graph.mute(target)).relationship, "muted");
  await social.graph.unmute(target);
  assert.equal((await social.graph.block(target)).relationship, "blocked");
  await social.graph.unblock(target);
  assert.deepEqual(requests, [
    { path: "/2/users/u1/following", method: "POST" },
    { path: "/2/users/u1/following/u2", method: "DELETE" },
    { path: "/2/users/u1/muting", method: "POST" },
    { path: "/2/users/u1/muting/u2", method: "DELETE" },
    { path: "/2/users/u1/blocking", method: "POST" },
    { path: "/2/users/u1/blocking/u2", method: "DELETE" },
  ]);
});
