import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  bluesky,
  blueskyJetstreamSubscription,
  createBlueskySession,
  parseBlueskyJetstreamEvent,
  refreshBlueskySession,
} from "../src/platforms/bluesky.js";
import {
  connectedAccountRef,
  SocialError,
  type JsonObject,
  type JsonValue,
} from "../src/core/index.js";
import { definedFields } from "../src/core/fields.js";
import { isJsonValue } from "../src/transport/json.js";
import { object } from "../src/transport/validation.js";

const did = "did:plc:test";

const account = connectedAccountRef({ backend: "default", platform: "bluesky", accountId: did });

const avatar = {
  $type: "blob" as const,
  ref: { $link: "bafkreiavatar" },
  mimeType: "image/png",
  size: 512,
};

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body?: JsonObject;
}

function json(value: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function decode(body: BodyInit | null | undefined): JsonObject | undefined {
  if (body === undefined || body === null) return undefined;

  const parsed: unknown = JSON.parse(String(body));
  assert.ok(isJsonValue(parsed));

  return object(parsed);
}

function recorder(route: (call: Call) => Response) {
  const calls: Call[] = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url: new URL(input instanceof Request ? input.url : String(input)),
      headers: new Headers(init?.headers),
      ...definedFields({ body: decode(init?.body) }),
    };

    calls.push(call);

    return route(call);
  };

  return { calls, fetch };
}

function harness(route: (call: Call) => Response) {
  const { calls, fetch } = recorder(route);

  const adapter = bluesky({
    auth: { service: "https://pds.example", did, accessJwt: "fixture" },
    fetch,
  });

  return { native: adapter.native!, calls };
}

const storedProfile = {
  $type: "app.bsky.actor.profile",
  displayName: "Old name",
  description: "Bio",
  avatar: { $type: "blob", ref: { $link: "bafkreiold" }, mimeType: "image/jpeg", size: 10 },
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("Bluesky profile record", () => {
  it("replaces the profile with swapRecord [feature:bluesky.account.profile.update]", async () => {
    const { native, calls } = harness(() =>
      json({ uri: `at://${did}/app.bsky.actor.profile/self`, cid: "bafynew" }),
    );

    await native.updateProfile({ account, profile: storedProfile, swapRecord: "bafyold" });

    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.repo.putRecord");
    assert.deepEqual(calls[0]?.body, {
      repo: did,
      collection: "app.bsky.actor.profile",
      rkey: "self",
      record: storedProfile,
      swapRecord: "bafyold",
    });

    await assert.rejects(
      native.updateProfile({ account, profile: { displayName: "No type" } }),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );
    assert.equal(calls.length, 1);
  });

  it("edits profile fields with a merge and compare-and-swap", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("getRecord")
        ? json({
            uri: `at://${did}/app.bsky.actor.profile/self`,
            cid: "bafyv1",
            value: storedProfile,
          })
        : json({ uri: `at://${did}/app.bsky.actor.profile/self`, cid: "bafyv2" }),
    );

    const ref = await native.editProfile({
      account,
      changes: { displayName: "New name", description: null, avatar, pronouns: "they/them" },
    });

    assert.deepEqual(ref, { uri: `at://${did}/app.bsky.actor.profile/self`, cid: "bafyv2" });
    assert.equal(calls[0]?.url.searchParams.get("collection"), "app.bsky.actor.profile");
    assert.equal(calls[0]?.url.searchParams.get("rkey"), "self");
    assert.equal(calls[1]?.body?.["swapRecord"], "bafyv1");
    assert.deepEqual(calls[1]?.body?.["record"], {
      $type: "app.bsky.actor.profile",
      displayName: "New name",
      pronouns: "they/them",
      avatar,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await assert.rejects(
      native.editProfile({ account, changes: { displayName: "x".repeat(65) } }),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );
    await assert.rejects(
      native.editProfile({ account, changes: { banner: { ...avatar, mimeType: "image/gif" } } }),
    );
    assert.equal(calls.length, 2);
  });

  it("pins and unpins a post through profile pinnedPost", async () => {
    let stored: JsonObject = storedProfile;

    const { native, calls } = harness(({ url, body }) => {
      if (url.pathname.endsWith("getRecord"))
        return json({
          uri: `at://${did}/app.bsky.actor.profile/self`,
          cid: "bafyv1",
          value: stored,
        });

      stored = object(body?.["record"]);

      return json({ uri: `at://${did}/app.bsky.actor.profile/self`, cid: "bafyv2" });
    });

    const post = { uri: `at://${did}/app.bsky.feed.post/3kpin`, cid: "bafypinned" };

    await native.pinPost({ account, post });
    assert.deepEqual(stored["pinnedPost"], post);
    assert.equal(stored["displayName"], "Old name");

    await native.pinPost({ account, post: null });
    assert.equal(stored["pinnedPost"], undefined);

    await assert.rejects(
      native.pinPost({
        account,
        post: { uri: "at://did:plc:other/app.bsky.feed.post/3k", cid: "bafyother" },
      }),
    );
    assert.equal(calls.length, 4);
  });

  it("creates the profile record when the account has none", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("getRecord")
        ? json({ error: "RecordNotFound", message: "Could not locate record" }, 400)
        : json({ uri: `at://${did}/app.bsky.actor.profile/self`, cid: "bafyfirst" }),
    );

    await native.editProfile({ account, changes: { displayName: "First" } });

    assert.equal(calls[1]?.url.pathname, "/xrpc/com.atproto.repo.createRecord");
    assert.equal(calls[1]?.body?.["rkey"], "self");
    assert.deepEqual(calls[1]?.body?.["record"], {
      $type: "app.bsky.actor.profile",
      displayName: "First",
    });
  });
});

describe("Bluesky live status and preferences", () => {
  it("writes an app.bsky.actor.status live record with durationMinutes", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("putRecord")
        ? json({ uri: `at://${did}/app.bsky.actor.status/self`, cid: "bafystatus" })
        : json({}),
    );

    await native.setLiveStatus({
      account,
      url: "https://stream.example/live",
      title: "Building in public",
      thumb: avatar,
      durationMinutes: 90,
    });

    const write = calls[0]?.body;
    assert.equal(write?.["collection"], "app.bsky.actor.status");
    assert.equal(write?.["rkey"], "self");

    const record = object(write?.["record"]);
    assert.equal(record["$type"], "app.bsky.actor.status");
    assert.equal(record["status"], "app.bsky.actor.status#live");
    assert.equal(record["durationMinutes"], 90);
    assert.deepEqual(record["embed"], {
      $type: "app.bsky.embed.external",
      external: {
        uri: "https://stream.example/live",
        title: "Building in public",
        description: "",
        thumb: avatar,
      },
    });

    await native.clearLiveStatus({ account });
    assert.deepEqual(calls[1]?.body, {
      repo: did,
      collection: "app.bsky.actor.status",
      rkey: "self",
    });

    await assert.rejects(
      native.setLiveStatus({ account, url: "https://stream.example", durationMinutes: 0 }),
    );
    assert.equal(calls.length, 2);
  });

  it("reads app.bsky.actor.getPreferences and writes app.bsky.actor.putPreferences", async () => {
    const muted = {
      $type: "app.bsky.actor.defs#mutedWordsPref",
      items: [{ value: "spoiler", targets: ["content", "tag"] }],
    };

    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("getPreferences") ? json({ preferences: [muted] }) : json({}),
    );

    const preferences = await native.getPreferences({ account });
    assert.deepEqual(preferences, [muted]);
    assert.equal(calls[0]?.url.pathname, "/xrpc/app.bsky.actor.getPreferences");

    await native.putPreferences({ account, preferences: [...preferences] });
    assert.equal(calls[1]?.url.pathname, "/xrpc/app.bsky.actor.putPreferences");
    assert.deepEqual(calls[1]?.body, { preferences: [muted] });

    await assert.rejects(native.putPreferences({ account, preferences: [{ items: [] }] }));
    assert.equal(calls.length, 2);
  });
});

describe("Bluesky app-password sessions", () => {
  const session = {
    did,
    handle: "test.example",
    accessJwt: "access-fixture",
    refreshJwt: "refresh-fixture-2",
    active: true,
  };

  it("signs in with com.atproto.server.createSession", async () => {
    const { calls, fetch } = recorder(() => json(session));

    const created = await createBlueskySession({
      service: "https://pds.example",
      identifier: " test.example ",
      password: "app-password-fixture",
      fetch,
    });

    assert.deepEqual(created, session);
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.url.href, "https://pds.example/xrpc/com.atproto.server.createSession");
    assert.deepEqual(calls[0]?.body, {
      identifier: "test.example",
      password: "app-password-fixture",
    });
  });

  it("refreshes with com.atproto.server.refreshSession using the refresh token", async () => {
    const { calls, fetch } = recorder(() => json(session));

    const refreshed = await refreshBlueskySession({
      service: "https://pds.example",
      refreshJwt: "refresh-fixture-1",
      fetch,
    });

    assert.equal(refreshed.refreshJwt, "refresh-fixture-2");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.server.refreshSession");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer refresh-fixture-1");
    assert.equal(calls[0]?.body, undefined);
  });

  it("maps an expired refresh token to reconnect_required and rejects bad sessions", async () => {
    const expired = recorder(() => json({ error: "ExpiredToken" }, 401));

    await assert.rejects(
      refreshBlueskySession({
        service: "https://pds.example",
        refreshJwt: "old",
        fetch: expired.fetch,
      }),
      (error) => error instanceof SocialError && error.code === "reconnect_required",
    );

    const broken = recorder(() => json({ did, handle: "x" }));

    await assert.rejects(
      refreshBlueskySession({
        service: "https://pds.example",
        refreshJwt: "r",
        fetch: broken.fetch,
      }),
      (error) => error instanceof SocialError && error.code === "upstream_failure",
    );

    await assert.rejects(
      createBlueskySession({ service: "http://pds.example", identifier: "a", password: "b" }),
      (error) => error instanceof SocialError && error.code === "invalid_config",
    );
  });
});

describe("Bluesky Jetstream", () => {
  it("builds a v2 subscribeEvents URL with collection, DID, kind, and cursor filters", () => {
    const subscription = blueskyJetstreamSubscription({
      collections: ["app.bsky.feed.post", "app.bsky.graph.*"],
      dids: [did],
      kinds: ["commit"],
      cursor: 24664288881,
    });

    assert.equal(
      subscription.url.href,
      "wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents?collections=app.bsky.feed.post&collections=app.bsky.graph.*&dids=did%3Aplc%3Atest&kinds=commit&cursor=24664288881",
    );
    assert.deepEqual(subscription.protocols, ["xrpc.v1.json"]);
  });

  it("builds a legacy v1 URL with wantedCollections and wantedDids", () => {
    const subscription = blueskyJetstreamSubscription({
      version: 1,
      collections: ["app.bsky.feed.like"],
      dids: [did],
    });

    assert.equal(subscription.url.pathname, "/subscribe");
    assert.deepEqual(subscription.url.searchParams.getAll("wantedCollections"), [
      "app.bsky.feed.like",
    ]);
    assert.deepEqual(subscription.url.searchParams.getAll("wantedDids"), [did]);
    assert.throws(() => blueskyJetstreamSubscription({ version: 1, kinds: ["commit"] }));
    assert.throws(() =>
      blueskyJetstreamSubscription({ collections: Array.from({ length: 101 }, () => "a.b.c") }),
    );
  });

  it("decodes v2 commit envelopes and v1 events", () => {
    const v2 = parseBlueskyJetstreamEvent(
      JSON.stringify({
        $type: "message",
        payload: {
          $type: "network.bsky.jetstream.subscribeEvents#commit",
          did: "did:plc:alice",
          seq: 24664288881,
          time: "2026-08-13T06:47:43.959305Z",
          operation: "create",
          collection: "app.bsky.feed.like",
          rkey: "3msx2efqdxs27",
          rev: "3msx2efqjtc27",
          cid: "bafyreilike",
          record: { $type: "app.bsky.feed.like", createdAt: "2026-08-13T06:47:44.859Z" },
        },
      }),
    );

    assert.deepEqual(v2, {
      kind: "commit",
      did: "did:plc:alice",
      seq: 24664288881,
      operation: "create",
      collection: "app.bsky.feed.like",
      rkey: "3msx2efqdxs27",
      uri: "at://did:plc:alice/app.bsky.feed.like/3msx2efqdxs27",
      rev: "3msx2efqjtc27",
      cid: "bafyreilike",
      record: { $type: "app.bsky.feed.like", createdAt: "2026-08-13T06:47:44.859Z" },
    });

    const v1 = parseBlueskyJetstreamEvent(
      JSON.stringify({
        did: "did:plc:alice",
        time_us: 1725911162329308,
        kind: "commit",
        commit: { rev: "r", operation: "delete", collection: "app.bsky.feed.post", rkey: "3k" },
      }),
    );

    assert.equal(v1?.kind, "commit");
    assert.equal(v1?.timeUs, 1725911162329308);
    assert.equal(v1?.kind === "commit" ? v1.record : "unexpected", undefined);

    const identity = parseBlueskyJetstreamEvent(
      JSON.stringify({
        $type: "message",
        payload: {
          $type: "network.bsky.jetstream.subscribeEvents#identity",
          did: "did:plc:alice",
          seq: 9,
          handle: "alice.example",
        },
      }),
    );

    assert.equal(identity?.kind, "identity");

    assert.equal(
      parseBlueskyJetstreamEvent(JSON.stringify({ $type: "info", payload: {} })),
      undefined,
    );
    assert.throws(
      () => parseBlueskyJetstreamEvent("not json"),
      (error) => error instanceof SocialError && error.code === "upstream_failure",
    );
  });
});
