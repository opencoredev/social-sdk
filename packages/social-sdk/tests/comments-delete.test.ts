/* oxlint-disable anti-slop/require-readable-spacing -- compact mocked-fetch fixtures keep request assertions local. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import { bluesky } from "../src/platforms/bluesky.js";
import { linkedin } from "../src/platforms/linkedin.js";
import { threads } from "../src/platforms/threads.js";
import { x } from "../src/platforms/x.js";
import { youtube } from "../src/platforms/youtube.js";

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly body: unknown;
}

const context = (backend: string): AdapterOperationContext => ({
  backendInstance: backend,
  correlationId: "comments-delete",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
});

function recorder(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch };
}

function declared(
  capabilities: readonly { readonly operation: string; readonly availability: string }[],
) {
  return capabilities.find((entry) => entry.operation === "comments.delete")?.availability;
}

it("YouTube deleteComment sends comments.delete with only the comment ID", async () => {
  const { calls, fetch } = recorder(() => new Response(null, { status: 204 }));
  const adapter = youtube({ auth: { accessToken: "token", channelId: "channel1" }, fetch });
  const account = connectedAccountRef({
    backend: "default",
    platform: "youtube",
    accountId: "channel1",
  });

  assert.equal(declared(adapter.capabilities.capabilities), "available");
  await adapter.native!.deleteComment({ account, commentId: "Ugz1", context: context("default") });

  assert.deepEqual(
    calls.map(({ method, url }) => [method, url.pathname, url.search]),
    [["DELETE", "/youtube/v3/comments", "?id=Ugz1"]],
  );
  await assert.rejects(
    adapter.native!.deleteComment({
      account: { ...account, accountId: "other" },
      commentId: "Ugz1",
      context: context("default"),
    }),
    { code: "unauthorized" },
  );
  await assert.rejects(
    adapter.native!.deleteComment({ account, commentId: " ", context: context("default") }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 1);
});

it("YouTube deleteComment reports a 403 as missing permission", async () => {
  const { fetch } = recorder(() =>
    Response.json({ error: { code: 403, errors: [{ reason: "forbidden" }] } }, { status: 403 }),
  );
  const adapter = youtube({ auth: { accessToken: "token", channelId: "channel1" }, fetch });
  const account = connectedAccountRef({
    backend: "default",
    platform: "youtube",
    accountId: "channel1",
  });

  await assert.rejects(
    adapter.native!.deleteComment({ account, commentId: "Ugz1", context: context("default") }),
    { code: "missing_permission" },
  );
});

it("Threads deleteComment deletes an own reply media ID and requires confirmation", async () => {
  let success = true;
  const { calls, fetch } = recorder(() => Response.json({ success, deleted_id: "1789" }));
  const adapter = threads({ auth: { userId: "42", accessToken: "token" }, fetch });
  const account = connectedAccountRef({ backend: "default", platform: "threads", accountId: "42" });

  const declaration = adapter.capabilities.capabilities.find(
    (entry) => entry.operation === "comments.delete",
  );
  assert.equal(declaration?.availability, "available");
  assert.deepEqual(declaration?.requiredScopes, ["threads_basic", "threads_delete"]);

  await adapter.native!.deleteComment({
    account,
    commentId: "1789",
    context: context("default"),
  });
  assert.equal(calls[0]?.method, "DELETE");
  assert.equal(calls[0]?.url.pathname.endsWith("/1789"), true);

  success = false;
  await assert.rejects(
    adapter.native!.deleteComment({ account, commentId: "1789", context: context("default") }),
    { code: "upstream_failure" },
  );
  await assert.rejects(
    adapter.native!.deleteComment({
      account,
      commentId: "1789/manage_reply",
      context: context("default"),
    }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    adapter.native!.deleteComment({
      account: { ...account, accountId: "7" },
      commentId: "1789",
      context: context("default"),
    }),
    { code: "unauthorized" },
  );
  assert.equal(calls.length, 2);
});

it("Bluesky deleteComment deletes only reply records in the authenticated repository", async () => {
  const { calls, fetch } = recorder(() => Response.json({}));
  const adapter = bluesky({
    auth: { service: "https://bsky.example", did: "did:plc:me", accessJwt: "jwt" },
    fetch,
  });
  const account = connectedAccountRef({
    backend: "default",
    platform: "bluesky",
    accountId: "did:plc:me",
  });

  assert.equal(declared(adapter.capabilities.capabilities), "available");
  await adapter.native!.deleteComment({
    account,
    commentId: "at://did:plc:me/app.bsky.feed.post/3kreply",
    context: context("default"),
  });

  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.repo.deleteRecord");
  assert.deepEqual(calls[0]?.body, {
    repo: "did:plc:me",
    collection: "app.bsky.feed.post",
    rkey: "3kreply",
  });

  await assert.rejects(
    adapter.native!.deleteComment({
      account,
      commentId: "at://did:plc:other/app.bsky.feed.post/3kreply",
      context: context("default"),
    }),
    { code: "unauthorized" },
  );
  await assert.rejects(
    adapter.native!.deleteComment({
      account,
      commentId: "at://did:plc:me/app.bsky.feed.post/bad/key",
      context: context("default"),
    }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 1);
});

it("X deleteComment deletes an own reply post and requires deleted=true", async () => {
  let deleted = true;
  const { calls, fetch } = recorder(() => Response.json({ data: { deleted } }));
  const adapter = x({ auth: { userId: "u1", accessToken: "token" }, fetch });
  const account = connectedAccountRef({ backend: "x", platform: "x", accountId: "u1" });

  assert.equal(declared(adapter.capabilities.capabilities), "available");
  await adapter.native!.deleteComment({
    account,
    commentId: "1346889436626259968",
    context: context("x"),
  });
  assert.deepEqual(
    calls.map(({ method, url }) => [method, url.pathname]),
    [["DELETE", "/2/tweets/1346889436626259968"]],
  );

  deleted = false;
  await assert.rejects(
    adapter.native!.deleteComment({
      account,
      commentId: "1346889436626259968",
      context: context("x"),
    }),
    { code: "ambiguous_outcome" },
  );
  await assert.rejects(
    adapter.native!.deleteComment({ account, commentId: "../users/1", context: context("x") }),
    { code: "invalid_input" },
  );
  assert.equal(calls.length, 2);
});

it("LinkedIn deleteComment uses the Comments API and sends organization actors", async () => {
  const { calls, fetch } = recorder(() => new Response(null, { status: 204 }));
  const member = linkedin({
    auth: { accessToken: "token", author: "urn:li:person:member1" },
    apiVersion: "202609",
    fetch,
  });
  const organization = linkedin({
    auth: { accessToken: "token", author: "urn:li:organization:12345" },
    apiVersion: "202609",
    fetch,
  });
  const memberAccount = connectedAccountRef({
    backend: "default",
    platform: "linkedin",
    accountId: "urn:li:person:member1",
  });
  const organizationAccount = connectedAccountRef({
    backend: "default",
    platform: "linkedin",
    accountId: "urn:li:organization:12345",
  });
  const commentId = "urn:li:comment:(urn:li:activity:6631349431612559360,6636062862760562688)";

  const memberDeclaration = member.capabilities.capabilities.find(
    (entry) => entry.operation === "comments.delete",
  );
  assert.deepEqual(memberDeclaration?.requiredScopes, ["w_member_social"]);
  const organizationDeclaration = organization.capabilities.capabilities.find(
    (entry) => entry.operation === "comments.delete",
  );
  assert.deepEqual(organizationDeclaration?.requiredScopes, ["w_organization_social"]);

  await member.native!.deleteComment({
    account: memberAccount,
    postId: "urn:li:share:6631349431612559360",
    commentId,
    context: context("default"),
  });
  await organization.native!.deleteComment({
    account: organizationAccount,
    postId: "urn:li:ugcPost:70161431162413057",
    commentId,
    context: context("default"),
  });

  assert.deepEqual(
    calls.map(({ method, url }) => [method, url.href]),
    [
      [
        "DELETE",
        "https://api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A6631349431612559360/comments/6636062862760562688",
      ],
      [
        "DELETE",
        "https://api.linkedin.com/rest/socialActions/urn%3Ali%3AugcPost%3A70161431162413057/comments/6636062862760562688?actor=urn%3Ali%3Aorganization%3A12345",
      ],
    ],
  );

  await assert.rejects(
    member.native!.deleteComment({
      account: memberAccount,
      postId: "urn:li:share:1",
      commentId: "6636062862760562688",
      context: context("default"),
    }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    member.native!.deleteComment({
      account: organizationAccount,
      postId: "urn:li:share:1",
      commentId,
      context: context("default"),
    }),
    { code: "unauthorized" },
  );
  assert.equal(calls.length, 2);
});
