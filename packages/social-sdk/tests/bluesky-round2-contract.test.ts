import { strict as assert } from "node:assert";
import { it } from "node:test";
import { account, did, empty, harness, json } from "./bluesky-harness.js";

it("allows a mute scoped to both reposts and quote posts", async () => {
  const { native, calls } = harness(() => empty());

  await assert.doesNotReject(
    native.mute({ account, did: "did:plc:alice", onlyReposts: true, onlyQuoteposts: true }),
  );

  assert.deepEqual(calls[0]?.body, {
    actor: "did:plc:alice",
    onlyReposts: true,
    onlyQuoteposts: true,
  });
});

it("propagates InvalidRequest instead of treating a declaration read as a missing record", async () => {
  const { native } = harness(() =>
    json({ error: "InvalidRequest", message: "Repository request could not be completed" }, 400),
  );

  await assert.rejects(native.getContentVisibility({ account }), {
    name: "SocialError",
    code: "upstream_failure",
    upstreamStatus: 400,
  });
});

it("preserves an uncertain profile-link creation when its success response lacks a CID", async () => {
  const { native, calls } = harness(() => json({ uri: `at://${did}/app.bsky.actor.link/3klink` }));

  await assert.rejects(native.createProfileLink({ account, url: "https://example.com" }), {
    name: "SocialError",
    code: "ambiguous_outcome",
    retryDisposition: { kind: "reconcile-first" },
  });

  assert.equal(calls.length, 1);
});

it("rejects a draft media path above the lexicon's 1024 UTF-8 bytes before dispatch", async () => {
  const { native, calls } = harness(() => json({ id: "3kdraftid2345" }));

  const path = `/${"猫".repeat(400)}.jpg`;

  assert.ok(new TextEncoder().encode(path).byteLength > 1024);

  await assert.rejects(
    native.createDraft({ account, draft: { posts: [{ text: "Photo", images: [{ path }] }] } }),
    { name: "SocialError", code: "invalid_input" },
  );

  assert.equal(calls.length, 0);
});

it("rejects draft captions above the lexicon's 10000 UTF-8 bytes before dispatch", async () => {
  const { native, calls } = harness(() => json({ id: "3kdraftid2345" }));

  const content = `WEBVTT\n\n00:00.000 --> 00:10.000\n${"猫".repeat(3400)}\n`;

  assert.ok(new TextEncoder().encode(content).byteLength > 10_000);

  await assert.rejects(
    native.createDraft({
      account,
      draft: {
        posts: [
          {
            text: "Clip",
            video: { path: "/clip.mp4", captions: [{ lang: "ja", content }] },
          },
        ],
      },
    }),
    { name: "SocialError", code: "invalid_input" },
  );

  assert.equal(calls.length, 0);
});
