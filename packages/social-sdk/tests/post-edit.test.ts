import { strict as assert } from "node:assert";
import { it } from "node:test";
import {
  connectedAccountRef,
  type AdapterOperationContext,
  type CapabilityManifest,
} from "../src/core/index.js";
import { bluesky } from "../src/platforms/bluesky.js";
import { instagram } from "../src/platforms/instagram.js";
import { threads } from "../src/platforms/threads.js";
import { tiktok } from "../src/platforms/tiktok.js";
import { x } from "../src/platforms/x.js";

const context: AdapterOperationContext = {
  backendInstance: "direct",
  correlationId: "post-edit",
  retryBudget: { maxAttempts: 3, maxElapsedMs: 10_000 },
};

const account = connectedAccountRef({ backend: "direct", platform: "x", accountId: "u1" });

const neverFetch: typeof fetch = async () => {
  throw new Error("No network request expected.");
};

const update = (manifest: CapabilityManifest) =>
  manifest.capabilities.find((entry) => entry.operation === "posts.update");

it("edits X post text through edit_options and returns the new version", async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];

  const adapter = x({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });

      return Response.json(
        {
          data: {
            id: "1900000000000000002",
            text: "Corrected text",
            edit_history_post_ids: ["1900000000000000001", "1900000000000000002"],
          },
        },
        { status: 201 },
      );
    },
  });

  const edited = await adapter.native!.updatePost({
    account,
    postId: "1900000000000000001",
    text: "Corrected text",
    context,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.x.com/2/tweets");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    text: "Corrected text",
    edit_options: { previous_post_id: "1900000000000000001" },
  });
  assert.deepEqual(edited, {
    post: {
      kind: "platform-post",
      version: 1,
      backend: "direct",
      platform: "x",
      accountId: "u1",
      postId: "1900000000000000002",
    },
    previousPostId: "1900000000000000001",
    text: "Corrected text",
    editHistoryPostIds: ["1900000000000000001", "1900000000000000002"],
  });

  const declared = update(adapter.capabilities);
  assert.equal(declared?.availability, "available");
  assert.deepEqual(declared?.requiredScopes, ["tweet.read", "tweet.write", "users.read"]);
});

it("rejects invalid X edits before any request", async () => {
  const adapter = x({ auth: { userId: "u1", accessToken: "token" }, fetch: neverFetch });

  for (const input of [
    { postId: "not-numeric", text: "Fine" },
    { postId: "1", text: "" },
    { postId: "1", text: "a".repeat(281) },
  ])
    await assert.rejects(() => adapter.native!.updatePost({ account, ...input, context }), {
      name: "SocialError",
      code: "invalid_input",
    });

  await assert.rejects(
    () =>
      adapter.native!.updatePost({
        account: connectedAccountRef({ backend: "direct", platform: "x", accountId: "other" }),
        postId: "1",
        text: "Fine",
        context,
      }),
    { name: "SocialError", code: "unauthorized" },
  );
});

it("treats an X edit without a confirmed new ID as uncertain", async () => {
  let calls = 0;

  const adapter = x({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async () => {
      calls++;

      return Response.json({ data: {} }, { status: 201 });
    },
  });

  await assert.rejects(
    () => adapter.native!.updatePost({ account, postId: "1", text: "Fine", context }),
    {
      name: "SocialError",
      code: "ambiguous_outcome",
      retryDisposition: { kind: "reconcile-first" },
    },
  );
  assert.equal(calls, 1);
});

it("sends an X edit once and reports a dispatched server failure as ambiguous", async () => {
  let calls = 0;

  const adapter = x({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async () => {
      calls++;

      return new Response("{}", { status: 503 });
    },
  });

  await assert.rejects(
    () => adapter.native!.updatePost({ account, postId: "1", text: "Fine", context }),
    {
      name: "SocialError",
      code: "ambiguous_outcome",
      retryDisposition: { kind: "reconcile-first" },
    },
  );
  assert.equal(calls, 1);
});

it("maps an ineligible X edit to a terminal permission error", async () => {
  const adapter = x({
    auth: { userId: "u1", accessToken: "token" },
    fetch: async () => Response.json({ title: "Forbidden" }, { status: 403 }),
  });

  await assert.rejects(
    () => adapter.native!.updatePost({ account, postId: "1", text: "Fine", context }),
    { name: "SocialError", code: "missing_permission", retryDisposition: { kind: "never" } },
  );
});

it("declares post editing unsupported where the platform has no edit API", () => {
  const manifests: readonly [string, CapabilityManifest][] = [
    [
      "threads",
      threads({ auth: { userId: "u1", accessToken: "token" }, fetch: neverFetch }).capabilities,
    ],
    [
      "bluesky",
      bluesky({
        auth: { service: "https://bsky.example", did: "did:plc:test", accessJwt: "token" },
        fetch: neverFetch,
      }).capabilities,
    ],
    [
      "instagram",
      instagram({ auth: { accountId: "ig1", accessToken: "token" }, fetch: neverFetch })
        .capabilities,
    ],
    [
      "instagram",
      instagram({
        auth: { accountId: "ig1", accessToken: "token", flavor: "facebook-login" },
        fetch: neverFetch,
      }).capabilities,
    ],
    [
      "tiktok",
      tiktok({
        auth: { accessToken: "token", openId: "creator1" },
        verifiedMediaOrigins: [],
        fetch: neverFetch,
      }).capabilities,
    ],
  ];

  for (const [platform, manifest] of manifests) {
    const declared = update(manifest);
    assert.equal(declared?.platform, platform);
    assert.equal(declared?.availability, "unsupported-by-platform");
    assert.ok(declared?.notes, `${platform} should document why editing is unsupported`);
  }
});
