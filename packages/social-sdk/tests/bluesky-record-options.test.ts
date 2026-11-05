import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createBlueskySession } from "../src/platforms/bluesky.js";
import { object } from "../src/transport/validation.js";
import {
  type Call,
  account,
  did,
  empty,
  harness,
  json,
  post,
  recorder,
  repost,
  starterPack,
} from "./bluesky-harness.js";

const record = (call: Call | undefined) => object(call?.body?.["record"]);

const invalid = { name: "SocialError", code: "invalid_input" };

describe("Bluesky via attribution", () => {
  it("records the repost a like and repost came through [feature:bluesky.engagement.via]", async () => {
    const { native, calls } = harness(({ body }) =>
      json({
        uri: `at://${did}/${String(body?.["collection"])}/3kself`,
        cid: "bafyreiselfcid",
      }),
    );

    await native.likePost({ account, post, via: repost });
    await native.repostPost({ account, post, via: repost });

    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.repo.createRecord");
    assert.equal(record(calls[0])["$type"], "app.bsky.feed.like");
    assert.deepEqual(record(calls[0])["subject"], post);
    assert.deepEqual(record(calls[0])["via"], repost);
    assert.equal(record(calls[1])["$type"], "app.bsky.feed.repost");
    assert.deepEqual(record(calls[1])["via"], repost);

    await assert.rejects(native.likePost({ account, post, via: post }), invalid);
    await assert.rejects(native.repostPost({ account, post, via: starterPack }), invalid);
    assert.equal(calls.length, 2);
  });

  it("credits a starter pack on follows and joinedViaStarterPack on the profile", async () => {
    const { native, calls } = harness(({ url, body }) =>
      url.pathname.endsWith("getRecord")
        ? json({ error: "RecordNotFound", message: "missing" }, 400)
        : body?.["collection"] === "app.bsky.actor.profile"
          ? json({ uri: `at://${did}/app.bsky.actor.profile/self`, cid: "bafyreiprofile" })
          : json({ uri: `at://${did}/app.bsky.graph.follow/3kfollow`, cid: "bafyreifollow" }),
    );

    await native.follow({ account, did: "did:plc:alice", via: starterPack });
    assert.deepEqual(record(calls[0])["via"], starterPack);
    assert.equal(record(calls[0])["subject"], "did:plc:alice");

    await native.editProfile({ account, changes: { joinedViaStarterPack: starterPack } });
    assert.equal(calls[2]?.url.pathname, "/xrpc/com.atproto.repo.createRecord");
    assert.deepEqual(record(calls[2])["joinedViaStarterPack"], starterPack);

    await assert.rejects(native.follow({ account, did: "did:plc:alice", via: repost }), invalid);
    await assert.rejects(
      native.editProfile({ account, changes: { joinedViaStarterPack: post } }),
      invalid,
    );
    assert.equal(calls.length, 3);
  });
});

describe("Bluesky graph options", () => {
  it("passes the follower and follow sort [feature:bluesky.graph.followSort]", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("getFollowers") ? json({ followers: [] }) : json({ follows: [] }),
    );

    await native.getFollowers({ account, actor: "alice.test", sort: "top", limit: 10 });
    await native.getFollows({ account, sort: "latest" });

    assert.equal(calls[0]?.url.pathname, "/xrpc/app.bsky.graph.getFollowers");
    assert.equal(calls[0]?.url.searchParams.get("sort"), "top");
    assert.equal(calls[0]?.url.searchParams.get("actor"), "alice.test");
    assert.equal(calls[1]?.url.pathname, "/xrpc/app.bsky.graph.getFollows");
    assert.equal(calls[1]?.url.searchParams.get("sort"), "latest");
  });

  it("scopes a mute with onlyReposts, onlyQuoteposts, or both", async () => {
    const { native, calls } = harness(() => empty());

    await native.mute({ account, did: "did:plc:alice", onlyReposts: true });
    await native.mute({ account, did: "did:plc:bob", onlyQuoteposts: true });
    await native.mute({ account, did: "did:plc:carol" });

    assert.equal(calls[0]?.url.pathname, "/xrpc/app.bsky.graph.muteActor");
    assert.deepEqual(calls[0]?.body, { actor: "did:plc:alice", onlyReposts: true });
    assert.deepEqual(calls[1]?.body, { actor: "did:plc:bob", onlyQuoteposts: true });
    assert.deepEqual(calls[2]?.body, { actor: "did:plc:carol" });

    await native.mute({ account, did: "did:plc:dan", onlyReposts: true, onlyQuoteposts: true });

    assert.deepEqual(calls[3]?.body, {
      actor: "did:plc:dan",
      onlyReposts: true,
      onlyQuoteposts: true,
    });
    assert.equal(calls.length, 4);
  });

  it("tags a moderation report with modTool", async () => {
    const report = {
      id: 7,
      reasonType: "com.atproto.moderation.defs#reasonSpam",
      subject: { $type: "com.atproto.admin.defs#repoRef", did: "did:plc:spam" },
      reportedBy: did,
      createdAt: "2026-11-04T00:00:00.000Z",
    };

    const { native, calls } = harness(() => json(report));

    const result = await native.createModerationReport({
      account,
      reasonType: "com.atproto.moderation.defs#reasonSpam",
      subject: { $type: "com.atproto.admin.defs#repoRef", did: "did:plc:spam" },
      modTool: { name: "example-queue/1.0", meta: { batch: "b-12" } },
    });

    assert.equal(result["id"], 7);
    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.moderation.createReport");
    assert.deepEqual(calls[0]?.body?.["modTool"], {
      name: "example-queue/1.0",
      meta: { batch: "b-12" },
    });

    await assert.rejects(
      native.createModerationReport({
        account,
        reasonType: "com.atproto.moderation.defs#reasonSpam",
        subject: { $type: "com.atproto.admin.defs#repoRef", did: "did:plc:spam" },
        modTool: { name: " " },
      }),
      invalid,
    );
    assert.equal(calls.length, 1);
  });
});

describe("Bluesky sign-in options", () => {
  it("sends allowTakendown and reports the takendown status", async () => {
    const { calls, fetch } = recorder(() =>
      json({
        did,
        handle: "test.example",
        accessJwt: "fixture-access",
        refreshJwt: "fixture-refresh",
        active: false,
        status: "takendown",
      }),
    );

    const session = await createBlueskySession({
      service: "https://pds.example",
      identifier: "test.example",
      password: "fixture-password",
      allowTakendown: true,
      fetch,
    });

    assert.equal(session.status, "takendown");
    assert.equal(session.active, false);
    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.server.createSession");
    assert.equal(calls[0]?.body?.["allowTakendown"], true);
  });
});
